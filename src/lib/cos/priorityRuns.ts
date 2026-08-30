import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { startTrace, completeTrace, emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";

/**
 * Audit-trail bookkeeping for priority_runs/priority_decisions -- mirrors
 * reconciliation/runs.ts's proven pattern (trace_id linkage so Inspector
 * General's existing object-trace lookup works unmodified) but writes to
 * its own tables, since prioritization is semantically distinct from
 * reconciliation (Post-Phase-6 Part 14).
 */

export type PriorityRunCounters = {
  itemsConsidered: number;
  directivesAssigned: number;
  overridesPreserved: number;
  overloadFlags: number;
  errors: number;
};

export function emptyPriorityCounters(): PriorityRunCounters {
  return { itemsConsidered: 0, directivesAssigned: 0, overridesPreserved: 0, overloadFlags: 0, errors: 0 };
}

export async function startPriorityRun(input: {
  trigger: "manual_request" | "scheduled_review" | "reassessment";
  scope: "all_active" | "project" | "item";
  scopeRef?: string | null;
  summary: string;
}): Promise<{ runId: string; traceId: string | null }> {
  const traceId = await startTrace({
    module: "cos_priority",
    sourceType: input.scope,
    sourceId: input.scopeRef ?? undefined,
    objectType: input.scope === "project" ? "execute_project_state" : input.scope === "item" ? "execution_item" : undefined,
    objectId: input.scopeRef ?? undefined,
    summary: input.summary,
    metadata: { trigger: input.trigger },
  });

  const { data, error } = await supabaseServer
    .from("priority_runs")
    .insert({ trigger: input.trigger, scope: input.scope, scope_ref: input.scopeRef ?? null, trace_id: traceId })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not start priority run: ${error?.message ?? "Unknown error"}`);

  await emitDiagnosticEvent({
    traceId,
    module: "cos_priority",
    stage: "start",
    eventType: "priority_run_started",
    status: "success",
    humanSummary: input.summary,
  });

  return { runId: data.id as string, traceId };
}

export async function completePriorityRun(
  runId: string,
  traceId: string | null,
  input: { status: "completed" | "failed"; counters: PriorityRunCounters; summary?: string }
): Promise<void> {
  try {
    const { error } = await supabaseServer
      .from("priority_runs")
      .update({
        status: input.status,
        completed_at: new Date().toISOString(),
        items_considered: input.counters.itemsConsidered,
        directives_assigned: input.counters.directivesAssigned,
        overrides_preserved: input.counters.overridesPreserved,
        overload_flags: input.counters.overloadFlags,
        errors: input.counters.errors,
      })
      .eq("id", runId);
    if (error) console.error("Could not complete priority run:", error.message);
  } catch (error) {
    console.error("Could not complete priority run:", error);
  }
  await completeTrace(traceId, { status: input.status, summary: input.summary });
}

export async function recordPriorityDecision(
  traceId: string | null,
  input: {
    runId: string;
    executionItemId?: string | null;
    projectStateId?: string | null;
    outcome: "assign_directive" | "reassess_directive" | "preserve_override" | "clear_directive" | "no_action" | "overload_detected";
    directive?: Record<string, unknown> | null;
    previousDirective?: Record<string, unknown> | null;
    signals?: Record<string, unknown>;
    modelName?: string | null;
    reasoningSummary: string;
  }
): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer
      .from("priority_decisions")
      .insert({
        run_id: input.runId,
        execution_item_id: input.executionItemId ?? null,
        project_state_id: input.projectStateId ?? null,
        outcome: input.outcome,
        directive: input.directive ?? null,
        previous_directive: input.previousDirective ?? null,
        signals: input.signals ?? {},
        model_provider: input.modelName ? "anthropic" : null,
        model_name: input.modelName ?? null,
        reasoning_summary: input.reasoningSummary,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Could not record priority decision:", error?.message);
      return null;
    }

    await emitDiagnosticEvent({
      traceId,
      module: "cos_priority",
      stage: "decide",
      eventType: input.outcome,
      status: "success",
      objectType: input.executionItemId ? "execution_item" : input.projectStateId ? "execute_project_state" : undefined,
      objectId: input.executionItemId ?? input.projectStateId ?? null,
      humanSummary: input.reasoningSummary,
      decisionType: input.outcome,
      decisionReason: input.reasoningSummary,
      metadata: { signals: input.signals },
    });

    return data.id as string;
  } catch (error) {
    console.error("Could not record priority decision:", error);
    return null;
  }
}
