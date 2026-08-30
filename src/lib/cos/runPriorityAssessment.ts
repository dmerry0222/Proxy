import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { createReconciliationAttentionItem } from "@/lib/reconciliation/attention";
import { completePriorityRun, emptyPriorityCounters, recordPriorityDecision, startPriorityRun } from "@/lib/cos/priorityRuns";
import { computeItemSignals, isEligibleForExecutionDirective, type ItemForSignals, type ProjectForSignals } from "@/lib/cos/computeSignals";
import { detectOverload, needsReassessment } from "@/lib/cos/priorityPolicy";
import { isManualOverrideActive, validatePriorityDirective, type ValidatedDirective } from "@/lib/cos/priorityDirective";
import { assignPrioritiesWithModel, type ItemPacket } from "@/lib/cos/priorityModel";

const MAX_ITEMS_PER_MODEL_CALL = 20;
const OVERDUE_ESCALATION_DAYS = 7;

type ItemRow = {
  id: string;
  title: string;
  description: string | null;
  status: ItemForSignals["status"];
  responsibility: ItemForSignals["responsibility"];
  confirmed_by_user: boolean;
  timing_at: string | null;
  timing_kind: ItemForSignals["timingKind"];
  deferred_until: string | null;
  waiting_since: string | null;
  expected_at: string | null;
  project_state_id: string | null;
  priority_directive: unknown;
};

function directiveSummary(raw: unknown): ItemForSignals["currentDirective"] {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.tier !== "string" || typeof value.source !== "string" || typeof value.decidedAt !== "string") return null;
  return { tier: value.tier, source: value.source, reassessAt: value.reassessAt as string | undefined, decidedAt: value.decidedAt };
}

export type PriorityAssessmentScope = { trigger: "manual_request" | "scheduled_review" | "reassessment"; scope: "all_active" | "project" | "item"; scopeRef?: string };

export async function runPriorityAssessment(input: PriorityAssessmentScope): Promise<{ runId: string }> {
  const { runId, traceId } = await startPriorityRun({
    trigger: input.trigger,
    scope: input.scope,
    scopeRef: input.scopeRef,
    summary: `Priority assessment (${input.scope}${input.scopeRef ? `: ${input.scopeRef}` : ""})`,
  });
  const counters = emptyPriorityCounters();

  try {
    let itemQuery = supabaseServer
      .from("execution_items")
      .select("id, title, description, status, responsibility, confirmed_by_user, timing_at, timing_kind, deferred_until, waiting_since, expected_at, project_state_id, priority_directive")
      .in("status", ["active", "candidate"]);
    if (input.scope === "project" && input.scopeRef) itemQuery = itemQuery.eq("project_state_id", input.scopeRef);
    if (input.scope === "item" && input.scopeRef) itemQuery = itemQuery.eq("id", input.scopeRef);

    const { data: itemRows, error: itemError } = await itemQuery;
    if (itemError) throw new Error(`Could not load items for prioritization: ${itemError.message}`);
    const items = (itemRows ?? []) as ItemRow[];
    counters.itemsConsidered = items.length;

    // Attention-priority-only escalation for overdue external work (Part 6):
    // never touches priority_directive/responsibility, only the existing
    // waiting_overdue attention item's urgency.
    await escalateOverdueExternalAttention(items);

    const eligibleItems = items.filter((item) => item.status === "active" && item.responsibility === "mine" && item.confirmed_by_user);

    const pendingAttentionCounts = await loadPendingAttentionCounts(eligibleItems.map((item) => item.id));
    const projectIds = [...new Set(eligibleItems.map((item) => item.project_state_id).filter((id): id is string => Boolean(id)))];
    const projects = await loadOrAssignProjectDirectives(projectIds, items, runId, traceId, counters);

    const forSignals: ItemForSignals[] = eligibleItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      responsibility: item.responsibility,
      confirmedByUser: item.confirmed_by_user,
      timingAt: item.timing_at,
      timingKind: item.timing_kind,
      deferredUntil: item.deferred_until,
      waitingSince: item.waiting_since,
      expectedAt: item.expected_at,
      projectStateId: item.project_state_id,
      currentDirective: directiveSummary(item.priority_directive),
      pendingAttentionCount: pendingAttentionCounts.get(item.id) ?? 0,
    }));

    const rowById = new Map(eligibleItems.map((row) => [row.id, row]));
    const signalsById = new Map(forSignals.map((signals) => [signals.id, computeItemSignals(signals, projects.get(signals.projectStateId ?? "") ?? null)]));

    // Overload detection (Part 19) must see the WHOLE current picture --
    // preserved overrides and untouched-but-still-current directives
    // included, not only what changes in this run -- otherwise a manual
    // P1 override or a directive from an earlier run could silently hide
    // from the incoherence check.
    const currentDirectives: Array<{ tier: string; protection: string }> = [];

    const toAssess = forSignals.filter((entry) => {
      const signals = signalsById.get(entry.id)!;
      if (!isEligibleForExecutionDirective(signals)) return false;
      const existing = directiveAsValidated(entry.currentDirective);
      const existingFull = rowById.get(entry.id)?.priority_directive as { tier?: string; protection?: string } | null;
      if (isManualOverrideActive(existing, new Date())) {
        counters.overridesPreserved += 1;
        if (existingFull?.tier && existingFull?.protection) currentDirectives.push({ tier: existingFull.tier, protection: existingFull.protection });
        void recordPriorityDecision(traceId, {
          runId,
          executionItemId: entry.id,
          outcome: "preserve_override",
          previousDirective: (rowById.get(entry.id)?.priority_directive as Record<string, unknown>) ?? null,
          signals: signals as unknown as Record<string, unknown>,
          reasoningSummary: "Active manual override preserved; not reassessed.",
        });
        return false;
      }
      if (input.trigger !== "manual_request" && !needsReassessment(signals).needed) {
        if (existingFull?.tier && existingFull?.protection) currentDirectives.push({ tier: existingFull.tier, protection: existingFull.protection });
        return false;
      }
      return true;
    });

    // Group by project (Part 16: relative prioritization within a
    // competing set), bounded per model call.
    const groups = new Map<string, typeof toAssess>();
    for (const entry of toAssess) {
      const key = entry.projectStateId ?? "__loose__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    }

    for (const [groupKey, groupItems] of groups) {
      const projectContext = groupKey !== "__loose__" ? projects.get(groupKey) ?? null : null;
      for (let offset = 0; offset < groupItems.length; offset += MAX_ITEMS_PER_MODEL_CALL) {
        const batch = groupItems.slice(offset, offset + MAX_ITEMS_PER_MODEL_CALL);
        const packets: ItemPacket[] = batch.map((entry) => {
          const row = rowById.get(entry.id)!;
          return { itemId: entry.id, title: entry.title, description: row.description, signals: signalsById.get(entry.id)!, timingAt: entry.timingAt, timingKind: entry.timingKind };
        });

        const projectDirective = projectContext?.currentDirective ? { tier: projectContext.currentDirective.tier, why: projectContext.currentDirective.why } : null;
        const assignments = await assignPrioritiesWithModel(packets, projectDirective as { tier: string; why: string } | null);

        for (const assignment of assignments) {
          if (!assignment.directive.ok) continue; // validator itself never lets an invalid shape through; defensive only.
          const row = rowById.get(assignment.itemId)!;
          const previousDirective = row.priority_directive as Record<string, unknown> | null;
          const { error } = await supabaseServer
            .from("execution_items")
            .update({ priority_directive: assignment.directive.directive, updated_at: new Date().toISOString() })
            .eq("id", assignment.itemId);
          if (error) {
            counters.errors += 1;
            continue;
          }
          counters.directivesAssigned += 1;
          currentDirectives.push({ tier: assignment.directive.directive.tier, protection: assignment.directive.directive.protection });
          await recordPriorityDecision(traceId, {
            runId,
            executionItemId: assignment.itemId,
            outcome: previousDirective ? "reassess_directive" : "assign_directive",
            directive: assignment.directive.directive as unknown as Record<string, unknown>,
            previousDirective,
            signals: signalsById.get(assignment.itemId) as unknown as Record<string, unknown>,
            modelName: assignment.usedFallback ? null : "claude-sonnet-4-5-20250929",
            reasoningSummary: assignment.directive.directive.why,
          });
        }
      }
    }

    const overload = detectOverload(currentDirectives);
    if (overload.overloaded) {
      counters.overloadFlags += 1;
      const attention = await createReconciliationAttentionItem({
        kind: "priority_conflict",
        title: "Too many items are protected P1 at once",
        detail: overload.reason ?? "The current priority picture may be incoherent.",
        dedupeKey: "cos:priority_conflict:overload",
        payload: { count: overload.count },
      });
      await recordPriorityDecision(traceId, {
        runId,
        outcome: "overload_detected",
        signals: { count: overload.count },
        reasoningSummary: overload.reason ?? "Overload detected.",
      });
      void attention;
    }

    await completePriorityRun(runId, traceId, {
      status: "completed",
      counters,
      summary: `Priority assessment: ${counters.directivesAssigned} directives assigned, ${counters.overridesPreserved} overrides preserved, ${counters.overloadFlags} overload flags.`,
    });
  } catch (error) {
    counters.errors += 1;
    await completePriorityRun(runId, traceId, { status: "failed", counters, summary: error instanceof Error ? error.message : "Unknown error" });
    throw error;
  }

  return { runId };
}

function directiveAsValidated(summary: ItemForSignals["currentDirective"]): ValidatedDirective | null {
  if (!summary) return null;
  return { tier: summary.tier, source: summary.source, reassessAt: summary.reassessAt, decidedAt: summary.decidedAt } as ValidatedDirective;
}

async function loadPendingAttentionCounts(itemIds: string[]): Promise<Map<string, number>> {
  if (!itemIds.length) return new Map();
  const { data } = await supabaseServer.from("execute_attention_items").select("execution_item_id").eq("status", "pending").in("execution_item_id", itemIds);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const id = row.execution_item_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Deterministic-only project-level tier (Part 7): projects lack the rich
 * per-item signal set, so no model call is warranted here -- just whether
 * any of its items are overdue-hard and whether it has a next_plateau at
 * all. Items then inherit `why`/`tier` as CONTEXT, never a copy of the
 * full directive (each item still gets its own timing/hardness/protection).
 */
async function loadOrAssignProjectDirectives(
  projectIds: string[],
  allItems: ItemRow[],
  runId: string,
  traceId: string | null,
  counters: ReturnType<typeof import("@/lib/cos/priorityRuns").emptyPriorityCounters>
): Promise<Map<string, ProjectForSignals>> {
  if (!projectIds.length) return new Map();

  const { data: projectRows, error } = await supabaseServer
    .from("execute_project_states")
    .select("id, status, next_plateau, priority_directive")
    .in("id", projectIds)
    .eq("status", "active");
  if (error) throw new Error(`Could not load projects for prioritization: ${error.message}`);

  const result = new Map<string, ProjectForSignals>();
  for (const project of projectRows ?? []) {
    const existing = directiveSummary(project.priority_directive);
    const validatedExisting = directiveAsValidated(existing);

    if (isManualOverrideActive(validatedExisting)) {
      counters.overridesPreserved += 1;
      result.set(project.id, { id: project.id, status: project.status, currentDirective: existing ? { tier: existing.tier, why: (project.priority_directive as { why?: string })?.why ?? "" } : null });
      continue;
    }

    const hasOverdueHardItem = allItems.some((item) => item.project_state_id === project.id && item.timing_kind === "must" && item.timing_at && new Date(item.timing_at) < new Date());
    const now = new Date();
    const reassessAt = new Date(now);
    reassessAt.setDate(reassessAt.getDate() + 14);

    const raw = hasOverdueHardItem
      ? { tier: "P1", why: "Contains work past a hard deadline.", hardness: "hard", protection: "protected", mayDisplace: [], source: "cos", decidedAt: now.toISOString(), reassessAt: reassessAt.toISOString() }
      : !project.next_plateau
        ? { tier: "P3", why: "Needs a next plateau before it can be protected.", hardness: "soft", protection: "flexible", mayDisplace: ["background"], source: "cos", decidedAt: now.toISOString(), reassessAt: reassessAt.toISOString() }
        : { tier: "P2", why: `Active project working toward: ${project.next_plateau}`, hardness: "moderate", protection: "normal", mayDisplace: ["P3", "background"], source: "cos", decidedAt: now.toISOString(), reassessAt: reassessAt.toISOString() };

    const validated = validatePriorityDirective(raw, null);
    if (!validated.ok) continue;

    const previousDirective = project.priority_directive as Record<string, unknown> | null;
    const changed = !existing || existing.tier !== validated.directive.tier;
    if (changed) {
      const { error: updateError } = await supabaseServer.from("execute_project_states").update({ priority_directive: validated.directive, updated_at: now.toISOString() }).eq("id", project.id);
      if (!updateError) {
        await recordPriorityDecision(traceId, {
          runId,
          projectStateId: project.id,
          outcome: previousDirective ? "reassess_directive" : "assign_directive",
          directive: validated.directive as unknown as Record<string, unknown>,
          previousDirective,
          reasoningSummary: validated.directive.why,
        });
      }
    }

    result.set(project.id, { id: project.id, status: project.status, currentDirective: { tier: validated.directive.tier, why: validated.directive.why } });
  }

  return result;
}

/**
 * External work never becomes Dave-owned (Part 6) -- this only adjusts the
 * urgency of an EXISTING waiting_overdue attention item (created by
 * overdueExternal.ts) so it surfaces sooner, never creates execution
 * priority for it.
 */
async function escalateOverdueExternalAttention(items: ItemRow[]): Promise<void> {
  const overdueExternal = items.filter(
    (item) => item.responsibility === "external" && item.status === "active" && item.expected_at && new Date(item.expected_at) < new Date()
  );
  for (const item of overdueExternal) {
    const daysOverdue = Math.floor((Date.now() - new Date(item.expected_at as string).getTime()) / 86_400_000);
    if (daysOverdue < OVERDUE_ESCALATION_DAYS) continue;
    await supabaseServer
      .from("execute_attention_items")
      .update({ urgency: "daily_review", updated_at: new Date().toISOString() })
      .eq("execution_item_id", item.id)
      .eq("kind", "waiting_overdue")
      .eq("status", "pending")
      .eq("urgency", "weekly_review");
  }
}
