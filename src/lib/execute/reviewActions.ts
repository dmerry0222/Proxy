import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { optionalUuid, requireString, requireTimestamp } from "@/lib/execute/validation";
import {
  planAcceptCandidate,
  planConfirmCancellation,
  planConfirmCompletion,
  planCorrectExternalOwner,
  planDeferCancellation,
  planEditExpectedAt,
  planEditItem,
  planExternalNotRelevant,
  planMarkAlreadyDone,
  planRejectCancellation,
  planRejectCandidate,
  planRejectCompletion,
  planResolveAmbiguousDifferent,
  planResolveExternal,
  planTrackWaiting,
  type ReviewPlan,
} from "@/lib/execute/reviewTransitions";
import { recordExecutionEvidence } from "@/lib/reconciliation/evidence";
import { completeReconciliationRun, emptyCounters, markDecisionUserOutcome, recordReconciliationDecision, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { EvidenceRelationship, EvidenceSourceType, SourceLocator } from "@/lib/reconciliation/types";

type ReviewAction =
  | { action: "accept_candidate"; itemId?: unknown }
  | { action: "reject_candidate"; itemId?: unknown; reason?: unknown }
  | { action: "mark_already_done"; itemId?: unknown }
  | { action: "edit_item"; itemId?: unknown; title?: unknown; timingAt?: unknown; timingKind?: unknown; projectStateId?: unknown }
  | { action: "merge_into"; itemId?: unknown; targetItemId?: unknown }
  | { action: "track_waiting"; itemId?: unknown }
  | { action: "resolve_external"; itemId?: unknown }
  | { action: "external_not_relevant"; itemId?: unknown }
  | { action: "correct_external_owner"; itemId?: unknown; relatedPersonEntityId?: unknown }
  | { action: "edit_expected_at"; itemId?: unknown; expectedAt?: unknown }
  | { action: "confirm_completion"; attentionItemId?: unknown }
  | { action: "reject_completion"; attentionItemId?: unknown }
  | { action: "confirm_cancellation"; attentionItemId?: unknown }
  | { action: "reject_cancellation"; attentionItemId?: unknown }
  | { action: "defer_cancellation"; attentionItemId?: unknown; deferUntil?: unknown }
  | { action: "resolve_ambiguous_same"; attentionItemId?: unknown }
  | { action: "resolve_ambiguous_different"; attentionItemId?: unknown }
  | { action: "dismiss_attention"; attentionItemId?: unknown };

async function findOriginDecisionId(itemId: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from("reconciliation_decisions")
    .select("id")
    .eq("matched_execution_item_id", itemId)
    .in("outcome", ["create_dave_item", "create_external_item"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

type AttentionRow = { id: string; execution_item_id: string | null; kind: string; payload: Record<string, unknown>; title: string };

async function loadAttentionItem(attentionItemId: string): Promise<AttentionRow> {
  const { data, error } = await supabaseServer
    .from("execute_attention_items")
    .select("id, execution_item_id, kind, payload, title")
    .eq("id", attentionItemId)
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw new Error(`Could not load attention item: ${error.message}`);
  if (!data) throw new Error("Attention item was not found or is no longer pending");
  return data as AttentionRow;
}

async function findDecisionForAttention(attentionItemId: string): Promise<string | null> {
  const { data } = await supabaseServer
    .from("reconciliation_decisions")
    .select("id")
    .eq("evidence_ref->>attentionItemId", attentionItemId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

async function resolveAttentionItem(attentionItemId: string): Promise<void> {
  const { error } = await supabaseServer
    .from("execute_attention_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", attentionItemId);
  if (error) throw new Error(`Could not resolve attention item: ${error.message}`);
}

/**
 * Every review action is a small manual reconciliation run (Post-Phase-5
 * Part 12/17) -- this makes each correction independently discoverable
 * from Inspector General via the same object-trace mechanism reconciliation
 * runs already use (object_type: "execution_item"), without inventing a
 * separate audit surface.
 */
async function withManualReviewRun<T>(itemId: string | null, summary: string, fn: (runId: string, traceId: string | null) => Promise<T>): Promise<T> {
  const { runId, traceId } = await startReconciliationRun({
    trigger: "manual_replay",
    sourceType: "execute_review",
    sourceId: itemId ?? "unscoped",
    summary,
  });
  const counters = emptyCounters();
  try {
    const result = await fn(runId, traceId);
    await completeReconciliationRun(runId, traceId, { status: "completed", counters, summary });
    return result;
  } catch (error) {
    counters.errors += 1;
    await completeReconciliationRun(runId, traceId, {
      status: "failed",
      counters,
      summary: error instanceof Error ? error.message : "Unknown review error",
    });
    throw error;
  }
}

async function applyItemPlan(itemId: string, plan: ReviewPlan, originDecisionId: string | null): Promise<void> {
  if (plan.itemPatch) {
    let query = supabaseServer.from("execution_items").update({ ...plan.itemPatch, updated_at: new Date().toISOString() }).eq("id", itemId);
    if (plan.requireStatus) query = query.in("status", plan.requireStatus);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw new Error(`Could not update execution item: ${error.message}`);
    if (!data) return; // Already applied (idempotent replay) or no longer in the expected state -- not an error.
  }

  if (originDecisionId && plan.userOutcome) {
    await markDecisionUserOutcome(originDecisionId, plan.userOutcome);
  }

  const auditOutcome = plan.auditOutcome;
  if (auditOutcome) {
    await withManualReviewRun(itemId, plan.auditReasoning ?? "Reconciliation review action", async (runId, traceId) => {
      await recordReconciliationDecision(traceId, {
        runId,
        evidenceRef: { executionItemId: itemId },
        outcome: auditOutcome,
        matchedExecutionItemId: itemId,
        automatic: false,
        reasoningSummary: plan.auditReasoning ?? "Reconciliation review action",
      });
    });
  }
}

async function runCandidateAction(itemId: unknown, plan: ReviewPlan): Promise<void> {
  const id = optionalUuid(itemId, "itemId");
  if (!id) throw new Error("itemId is required");
  const originDecisionId = await findOriginDecisionId(id);
  await applyItemPlan(id, plan, originDecisionId);
}

async function runAttentionAction(
  attentionItemId: unknown,
  planFor: (row: AttentionRow) => ReviewPlan
): Promise<void> {
  const id = optionalUuid(attentionItemId, "attentionItemId");
  if (!id) throw new Error("attentionItemId is required");
  const row = await loadAttentionItem(id);
  const plan = planFor(row);
  const decisionId = await findDecisionForAttention(id);

  if (row.execution_item_id) {
    await applyItemPlan(row.execution_item_id, plan, decisionId);
  } else if (decisionId && plan.userOutcome) {
    await markDecisionUserOutcome(decisionId, plan.userOutcome);
  }

  await resolveAttentionItem(id);
}

async function resolveAmbiguousSame(attentionItemId: unknown): Promise<void> {
  const id = optionalUuid(attentionItemId, "attentionItemId");
  if (!id) throw new Error("attentionItemId is required");
  const row = await loadAttentionItem(id);
  if (row.kind !== "ambiguous_merge" || !row.execution_item_id) {
    throw new Error("This attention item is not an ambiguous match");
  }

  const payload = row.payload;
  const decisionId = await findDecisionForAttention(id);

  await withManualReviewRun(row.execution_item_id, "Dave confirmed an ambiguous match", async (runId, traceId) => {
    if (payload.sourceType && payload.sourceLocator) {
      await recordExecutionEvidence({
        executionItemId: row.execution_item_id as string,
        sourceType: payload.sourceType as EvidenceSourceType,
        sourceLocator: payload.sourceLocator as SourceLocator,
        relationship: (payload.relationship as EvidenceRelationship) ?? "supports_ownership",
        excerpt: typeof payload.excerpt === "string" ? payload.excerpt : null,
        occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : null,
      });
    }
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { executionItemId: row.execution_item_id, attentionItemId: id },
      outcome: "attach_evidence",
      matchedExecutionItemId: row.execution_item_id,
      confidence: typeof payload.score === "number" ? payload.score : null,
      matchBasis: "user-confirmed match (Reconciliation Review)",
      automatic: false,
      reasoningSummary: "Dave confirmed this evidence describes the same obligation as the matched item.",
    });
  });

  if (decisionId) await markDecisionUserOutcome(decisionId, "confirmed");
  await resolveAttentionItem(id);
}

async function mergeInto(itemId: unknown, targetItemId: unknown): Promise<void> {
  const loserId = optionalUuid(itemId, "itemId");
  const winnerId = optionalUuid(targetItemId, "targetItemId");
  if (!loserId || !winnerId) throw new Error("itemId and targetItemId are required");
  if (loserId === winnerId) throw new Error("Cannot merge an item into itself");

  const { data: winner, error: winnerError } = await supabaseServer.from("execution_items").select("id").eq("id", winnerId).maybeSingle();
  if (winnerError || !winner) throw new Error("Target item was not found");

  // Re-point the loser's evidence at the winner. A row that would collide
  // with an identical (item, source, locator, relationship) tuple already
  // on the winner is left on the loser rather than erroring -- the winner
  // already has that exact evidence, so nothing is lost.
  const { data: loserEvidence } = await supabaseServer
    .from("execution_evidence")
    .select("id, source_type, source_locator, relationship")
    .eq("execution_item_id", loserId);
  for (const row of loserEvidence ?? []) {
    const { error } = await supabaseServer.from("execution_evidence").update({ execution_item_id: winnerId }).eq("id", row.id);
    if (error) continue; // unique-constraint collision with existing winner evidence -- acceptable, not fatal.
  }

  const { error } = await supabaseServer
    .from("execution_items")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), metadata: { merged_into: winnerId }, updated_at: new Date().toISOString() })
    .eq("id", loserId);
  if (error) throw new Error(`Could not close the merged item: ${error.message}`);

  await withManualReviewRun(winnerId, "Dave merged a duplicate item", async (runId, traceId) => {
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { executionItemId: winnerId, mergedFrom: loserId },
      outcome: "attach_evidence",
      matchedExecutionItemId: winnerId,
      automatic: false,
      reasoningSummary: `Dave merged a duplicate item into this one.`,
    });
  });

  const originDecisionId = await findOriginDecisionId(loserId);
  if (originDecisionId) await markDecisionUserOutcome(originDecisionId, "corrected");
}

export async function applyReconciliationReviewAction(input: ReviewAction): Promise<{ ok: true }> {
  if (!input || typeof input !== "object" || typeof (input as { action?: unknown }).action !== "string") {
    throw new Error("A valid action is required");
  }

  switch (input.action) {
    case "accept_candidate":
      await runCandidateAction(input.itemId, planAcceptCandidate());
      break;
    case "reject_candidate": {
      const reason = input.reason === "not_mine" ? "not_mine" : "not_a_task";
      await runCandidateAction(input.itemId, planRejectCandidate(reason));
      break;
    }
    case "mark_already_done":
      await runCandidateAction(input.itemId, planMarkAlreadyDone());
      break;
    case "edit_item": {
      const id = optionalUuid(input.itemId, "itemId");
      if (!id) throw new Error("itemId is required");
      const plan = planEditItem({
        title: typeof input.title === "string" && input.title.trim() ? requireString(input.title, "title", 300) : undefined,
        timingAt: input.timingAt === null ? null : typeof input.timingAt === "string" && input.timingAt ? requireTimestamp(input.timingAt, "timingAt") : undefined,
        timingKind: input.timingKind === "must" || input.timingKind === "target" ? input.timingKind : undefined,
        projectStateId: input.projectStateId === null ? null : optionalUuid(input.projectStateId, "projectStateId") ?? undefined,
      });
      if (plan.itemPatch) await applyItemPlan(id, plan, await findOriginDecisionId(id));
      break;
    }
    case "merge_into":
      await mergeInto(input.itemId, input.targetItemId);
      break;
    case "track_waiting":
      await runCandidateAction(input.itemId, planTrackWaiting());
      break;
    case "resolve_external":
      await runCandidateAction(input.itemId, planResolveExternal());
      break;
    case "external_not_relevant":
      await runCandidateAction(input.itemId, planExternalNotRelevant());
      break;
    case "correct_external_owner": {
      const relatedPersonEntityId = optionalUuid(input.relatedPersonEntityId, "relatedPersonEntityId");
      if (!relatedPersonEntityId) throw new Error("relatedPersonEntityId is required");
      await runCandidateAction(input.itemId, planCorrectExternalOwner(relatedPersonEntityId));
      break;
    }
    case "edit_expected_at": {
      const expectedAt = requireTimestamp(input.expectedAt, "expectedAt");
      await runCandidateAction(input.itemId, planEditExpectedAt(expectedAt));
      break;
    }
    case "confirm_completion":
      await runAttentionAction(input.attentionItemId, () => planConfirmCompletion());
      break;
    case "reject_completion":
      await runAttentionAction(input.attentionItemId, () => planRejectCompletion());
      break;
    case "confirm_cancellation":
      await runAttentionAction(input.attentionItemId, () => planConfirmCancellation());
      break;
    case "reject_cancellation":
      await runAttentionAction(input.attentionItemId, () => planRejectCancellation());
      break;
    case "defer_cancellation": {
      const deferUntil = input.deferUntil ? requireTimestamp(input.deferUntil, "deferUntil") : null;
      await runAttentionAction(input.attentionItemId, () => planDeferCancellation(deferUntil));
      break;
    }
    case "resolve_ambiguous_same":
      await resolveAmbiguousSame(input.attentionItemId);
      break;
    case "resolve_ambiguous_different":
      await runAttentionAction(input.attentionItemId, () => planResolveAmbiguousDifferent());
      break;
    case "dismiss_attention": {
      const id = optionalUuid(input.attentionItemId, "attentionItemId");
      if (!id) throw new Error("attentionItemId is required");
      const { error } = await supabaseServer
        .from("execute_attention_items")
        .update({ status: "dismissed", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw new Error(`Could not dismiss attention item: ${error.message}`);
      break;
    }
    default:
      throw new Error("Unsupported review action");
  }

  return { ok: true };
}
