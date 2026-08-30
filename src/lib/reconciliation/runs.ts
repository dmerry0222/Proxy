import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { startTrace, completeTrace, emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import type { ReconciliationDecisionInput, ReconciliationOutcome, ReconciliationTrigger } from "./types";

/*
 * Reconciliation audit records are deliberately separate from
 * diagnostic_traces/diagnostic_events (those are generic pipeline
 * observability; these carry match-basis/ownership-basis/confidence/
 * user-outcome semantics specific to reconciliation decisions) but every
 * run opens a diagnostic_traces row too (module: "reconciliation") so
 * Inspector General's existing trace/event UI and health-check registry
 * work for this pipeline without any new UI.
 *
 * Like emitEvent.ts, failures here are logged, not thrown, EXCEPT for
 * starting a run -- callers need a real run id to proceed, so that one
 * failure does propagate.
 */

export type ReconciliationRunCounters = {
  evidenceConsidered: number;
  itemsCreated: number;
  itemsMatched: number;
  itemsIgnored: number;
  errors: number;
};

export async function startReconciliationRun(input: {
  trigger: ReconciliationTrigger;
  sourceType: string;
  /**
   * The stable source identifier (outlookMessageId, chatId, artifactId,
   * ...) -- required so Inspector General's object-trace lookup
   * (object_type/object_id) can find this run's trace directly, the same
   * way it already can for Memory's own email trace. Phase 4.5 finding:
   * Teams reconciliation traces were previously unreachable that way,
   * discoverable only via reconciliation_runs.trace_id.
   */
  sourceId: string;
  horizonStart?: string | null;
  horizonEnd?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string; traceId: string | null }> {
  const traceId = await startTrace({
    module: "reconciliation",
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    objectType: input.sourceType,
    objectId: input.sourceId,
    summary: input.summary,
    metadata: { trigger: input.trigger },
  });

  const { data, error } = await supabaseServer
    .from("reconciliation_runs")
    .insert({
      trigger: input.trigger,
      source_type: input.sourceType,
      trace_id: traceId,
      horizon_start: input.horizonStart ?? null,
      horizon_end: input.horizonEnd ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Could not start reconciliation run: ${error?.message ?? "Unknown error"}`);
  }

  // Phase 4.5 Finding D, corrected understanding: Inspector General's
  // object-trace lookup (loadTraceForObject.ts) queries diagnostic_EVENTS
  // by object_type/object_id, not diagnostic_traces -- setting those
  // fields on the trace itself (above) doesn't make it reachable that way.
  // This event is what actually closes the gap: a source-tagged event on
  // the reconciliation trace, findable by (sourceType, sourceId) the same
  // way Memory's own email trace already was.
  await emitDiagnosticEvent({
    traceId,
    module: "reconciliation",
    stage: "start",
    eventType: "reconciliation_started",
    status: "success",
    objectType: input.sourceType,
    objectId: input.sourceId,
    humanSummary: input.summary,
  });

  return { runId: data.id as string, traceId };
}

export async function completeReconciliationRun(
  runId: string,
  traceId: string | null,
  input: { status: "completed" | "failed"; counters: ReconciliationRunCounters; cursor?: Record<string, unknown>; summary?: string }
): Promise<void> {
  try {
    const { error } = await supabaseServer
      .from("reconciliation_runs")
      .update({
        status: input.status,
        completed_at: new Date().toISOString(),
        evidence_considered: input.counters.evidenceConsidered,
        items_created: input.counters.itemsCreated,
        items_matched: input.counters.itemsMatched,
        items_ignored: input.counters.itemsIgnored,
        errors: input.counters.errors,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })
      .eq("id", runId);

    if (error) {
      console.error("Could not complete reconciliation run:", error.message);
    }
  } catch (error) {
    console.error("Could not complete reconciliation run:", error);
  }

  await completeTrace(traceId, { status: input.status, summary: input.summary });
}

/**
 * Records one reconciliation decision -- the answer to "why did Proxy do
 * (or not do) this." Also emits a matching diagnostic event on the run's
 * trace so it shows up in Inspector General's trace view, and opens a
 * retryable diagnostic issue for ambiguous_review outcomes so unreviewed
 * reconciliation uncertainty is observable rather than silently dropped.
 */
export async function recordReconciliationDecision(
  traceId: string | null,
  input: ReconciliationDecisionInput
): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer
      .from("reconciliation_decisions")
      .insert({
        run_id: input.runId,
        evidence_ref: input.evidenceRef,
        outcome: input.outcome,
        matched_execution_item_id: input.matchedExecutionItemId ?? null,
        confidence: input.confidence ?? null,
        ownership_basis: input.ownershipBasis ?? null,
        match_basis: input.matchBasis ?? null,
        model_provider: input.modelProvider ?? null,
        model_name: input.modelName ?? null,
        model_version: input.modelVersion ?? null,
        automatic: input.automatic,
        user_outcome: input.automatic ? null : "pending",
        reasoning_summary: input.reasoningSummary,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Could not record reconciliation decision:", error?.message);
      return null;
    }

    const decisionId = data.id as string;

    await emitDiagnosticEvent({
      traceId,
      module: "reconciliation",
      stage: "decide",
      eventType: input.outcome,
      status: "success",
      objectType: "execution_item",
      objectId: input.matchedExecutionItemId ?? null,
      humanSummary: input.reasoningSummary,
      decisionType: input.outcome,
      decisionReason: input.reasoningSummary,
      metadata: { confidence: input.confidence, ownershipBasis: input.ownershipBasis, matchBasis: input.matchBasis },
    });

    if (input.outcome === "ambiguous_review") {
      await recordIssue({
        traceId,
        issueType: "reconciliation_ambiguous",
        severity: "info",
        humanSummary: "Reconciliation decision needs review",
        humanDetail: input.reasoningSummary,
        objectType: "execution_item",
        objectId: input.matchedExecutionItemId ?? null,
        retryable: false,
      });
    }

    return decisionId;
  } catch (error) {
    console.error("Could not record reconciliation decision:", error);
    return null;
  }
}

export async function markDecisionUserOutcome(
  decisionId: string,
  outcome: "confirmed" | "corrected" | "rejected"
): Promise<void> {
  try {
    const { error } = await supabaseServer.from("reconciliation_decisions").update({ user_outcome: outcome }).eq("id", decisionId);
    if (error) {
      console.error("Could not update reconciliation decision outcome:", error.message);
    }
  } catch (error) {
    console.error("Could not update reconciliation decision outcome:", error);
  }
}

export function emptyCounters(): ReconciliationRunCounters {
  return { evidenceConsidered: 0, itemsCreated: 0, itemsMatched: 0, itemsIgnored: 0, errors: 0 };
}

export type { ReconciliationOutcome };
