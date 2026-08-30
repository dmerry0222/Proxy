import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { createReconciliationAttentionItem } from "./attention";
import { recordExecutionEvidence } from "./evidence";
import {
  RANK_ATTACH_THRESHOLD,
  RANK_REVIEW_THRESHOLD,
  filterByResponsibility,
  findCandidateExecutionItems,
  rankCandidatesByTitle,
} from "./matchCandidates";
import { gatesDaveOwnership, gatesExternalOwnership } from "./ownershipRules";
import { recordReconciliationDecision } from "./runs";
import type { ActionEvidenceEnvelope, EvidenceSourceType, ReconciliationOutcome, SourceLocator } from "./types";
import type { CandidateExecutionItem } from "./matchCandidates";

export type ReconcileResult = { outcome: ReconciliationOutcome; executionItemId: string | null };

/**
 * The shared apply-function every source (email now, Teams/calendar later)
 * hands one ActionEvidenceEnvelope to. Source processors build the
 * envelope (source-specific AI extraction); everything from here down --
 * matching, the create-vs-attach-vs-review decision, writing
 * execution_items/execution_evidence, and the audit trail -- is generic
 * (Brief Part 16: "source processors should pass structured evidence into
 * a shared reconciliation layer").
 *
 * Scope note (Phase 3): completion and cancellation are ALWAYS routed to
 * review (execute_attention_items), never applied automatically -- see
 * Brief Part 4.E/20. Automatic status transitions based on AI-detected
 * evidence are not built in this phase. Project association/nomination
 * (Part 12) is out of scope until Phase 6; envelope.projectHint is
 * currently unused here.
 */
export async function reconcileEnvelope(params: {
  envelope: ActionEvidenceEnvelope;
  runId: string;
  traceId: string | null;
}): Promise<ReconcileResult> {
  const { envelope, runId, traceId } = params;

  if (envelope.completion?.likely) {
    return applyCompletionOrCancellation(envelope, runId, traceId, "completion");
  }
  if (envelope.cancellation?.likely) {
    return applyCompletionOrCancellation(envelope, runId, traceId, "cancellation");
  }

  if (gatesDaveOwnership(envelope.ownership)) {
    return applyOwnedCreationOrMerge(envelope, runId, traceId, "mine");
  }
  if (gatesExternalOwnership(envelope.ownership)) {
    return applyOwnedCreationOrMerge(envelope, runId, traceId, "external");
  }

  await recordReconciliationDecision(traceId, {
    runId,
    evidenceRef: { sourceLocator: envelope.sourceLocator },
    outcome: "no_action",
    automatic: true,
    reasoningSummary: "No ownership, completion, or cancellation evidence cleared the bar for operational action.",
  });
  return { outcome: "no_action", executionItemId: null };
}

async function applyOwnedCreationOrMerge(
  envelope: ActionEvidenceEnvelope,
  runId: string,
  traceId: string | null,
  responsibility: "mine" | "external"
): Promise<ReconcileResult> {
  const ownership = envelope.ownership;
  const basis = ownership.owner === "ambiguous" ? null : ownership.basis;
  const excerpt = ownership.owner === "ambiguous" ? envelope.excerpt : ownership.excerpt;
  const titleHint = (envelope.candidateTitle ?? envelope.excerpt).trim();

  const candidates = filterByResponsibility(await findCandidateExecutionItems({ actors: envelope.actors }), responsibility);
  const ranked = rankCandidatesByTitle(titleHint, candidates);
  const top = ranked[0];

  if (top && top.score >= RANK_ATTACH_THRESHOLD) {
    const evidence = await recordExecutionEvidence({
      executionItemId: top.item.id,
      sourceType: envelope.sourceType,
      sourceLocator: envelope.sourceLocator,
      relationship: "supports_ownership",
      excerpt,
      occurredAt: envelope.occurredAt,
    });

    let outcome: ReconciliationOutcome = "attach_evidence";
    if (envelope.timing && envelope.timing.at !== top.item.timingAt) {
      const { error } = await supabaseServer
        .from("execution_items")
        .update({ timing_at: envelope.timing.at, timing_kind: envelope.timing.kind, updated_at: new Date().toISOString() })
        .eq("id", top.item.id);
      if (error) {
        throw new Error(`Could not update timing on execution item: ${error.message}`);
      }
      await recordExecutionEvidence({
        executionItemId: top.item.id,
        sourceType: envelope.sourceType,
        sourceLocator: envelope.sourceLocator,
        relationship: "supports_timing",
        excerpt,
        occurredAt: envelope.occurredAt,
      });
      outcome = "update_timing";
    }

    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { evidenceId: evidence.id, executionItemId: top.item.id },
      outcome,
      matchedExecutionItemId: top.item.id,
      confidence: top.score,
      ownershipBasis: basis,
      matchBasis: `title similarity ${top.score.toFixed(2)} to "${top.item.title}"`,
      automatic: true,
      reasoningSummary: `Matched existing ${responsibility === "mine" ? "Dave-owned" : "external"} item "${top.item.title}" (similarity ${top.score.toFixed(2)}); ${outcome === "update_timing" ? "timing updated, " : ""}evidence attached.`,
    });
    return { outcome, executionItemId: top.item.id };
  }

  if (top && top.score >= RANK_REVIEW_THRESHOLD) {
    const attention = await createReconciliationAttentionItem({
      kind: "ambiguous_merge",
      executionItemId: top.item.id,
      title: `Possible duplicate: "${titleHint}"`,
      detail: `This may be the same obligation as existing item "${top.item.title}" (similarity ${top.score.toFixed(2)}), below the auto-merge threshold. Evidence: "${excerpt}"`,
      dedupeKey: `reconciliation:ambiguous_merge:${top.item.id}:${JSON.stringify(envelope.sourceLocator)}`,
      // Carries everything a later "same item" review decision needs to
      // actually attach this evidence (Post-Phase-5 Part 6/12) -- score and
      // excerpt alone were enough to show Dave the proposal, but not enough
      // to record execution_evidence for it after the fact.
      payload: {
        candidateItemId: top.item.id,
        score: top.score,
        excerpt,
        proposedTitle: titleHint,
        sourceType: envelope.sourceType,
        sourceLocator: envelope.sourceLocator,
        occurredAt: envelope.occurredAt,
        relationship: responsibility === "mine" ? "supports_ownership" : "supports_external_owner",
      },
    });
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { attentionItemId: attention.id },
      outcome: "ambiguous_review",
      matchedExecutionItemId: top.item.id,
      confidence: top.score,
      ownershipBasis: basis,
      matchBasis: `title similarity ${top.score.toFixed(2)} to "${top.item.title}" (below auto-merge threshold)`,
      automatic: true,
      reasoningSummary: `Possible match to "${top.item.title}" (similarity ${top.score.toFixed(2)}) is too uncertain to merge automatically; routed to review.`,
    });
    return { outcome: "ambiguous_review", executionItemId: null };
  }

  const insertPayload: Record<string, unknown> = {
    title: titleHint.slice(0, 300),
    responsibility,
    status: "candidate",
    extraction_basis: basis,
    timing_at: envelope.timing?.at ?? null,
    timing_kind: envelope.timing?.kind ?? null,
    metadata: { source_type: envelope.sourceType, ownership_evidence: excerpt },
  };
  if (responsibility === "external") {
    const actor = ownership.owner === "external" ? ownership.actor : null;
    insertPayload.related_person_entity_id = actor?.entityId ?? null;
    insertPayload.waiting_since = envelope.occurredAt;
    insertPayload.expected_at = envelope.timing?.at ?? null;
    insertPayload.obligation_context = excerpt;
  } else {
    // Whoever supplied this evidence (the email's sender, a meeting
    // participant, etc.) is the requester -- without this, later evidence
    // from the same person has no actor to match against, and
    // findCandidateExecutionItems' narrowing can never find this item
    // regardless of title similarity.
    insertPayload.requester_entity_id = envelope.actors[0]?.entityId ?? null;
  }

  const { data: row, error } = await supabaseServer.from("execution_items").insert(insertPayload).select("id").single();
  if (error || !row) {
    throw new Error(`Could not create execution item: ${error?.message ?? "Unknown error"}`);
  }

  await recordExecutionEvidence({
    executionItemId: row.id,
    sourceType: envelope.sourceType,
    sourceLocator: envelope.sourceLocator,
    relationship: "supports_creation",
    excerpt,
    occurredAt: envelope.occurredAt,
  });

  const outcome: ReconciliationOutcome = responsibility === "mine" ? "create_dave_item" : "create_external_item";
  await recordReconciliationDecision(traceId, {
    runId,
    evidenceRef: { executionItemId: row.id },
    outcome,
    matchedExecutionItemId: row.id,
    ownershipBasis: basis,
    automatic: true,
    reasoningSummary: `${responsibility === "mine" ? "Explicit Dave" : "Explicit external"} ownership (${basis}): "${excerpt}". No existing item matched closely enough to merge.`,
  });
  return { outcome, executionItemId: row.id };
}

async function applyCompletionOrCancellation(
  envelope: ActionEvidenceEnvelope,
  runId: string,
  traceId: string | null,
  kind: "completion" | "cancellation"
): Promise<ReconcileResult> {
  const signal = kind === "completion" ? envelope.completion : envelope.cancellation;
  const titleHint = (envelope.candidateTitle ?? envelope.excerpt).trim();

  const candidates = filterByResponsibility(await findCandidateExecutionItems({ actors: envelope.actors }), "mine");
  const ranked = rankCandidatesByTitle(titleHint, candidates);
  const top = ranked[0];

  if (!top || top.score < RANK_REVIEW_THRESHOLD) {
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { sourceLocator: envelope.sourceLocator },
      outcome: "no_action",
      automatic: true,
      reasoningSummary: `${kind === "completion" ? "Completion" : "Cancellation"} language detected ("${signal?.excerpt}") but no open item matched closely enough to act on.`,
    });
    return { outcome: "no_action", executionItemId: null };
  }

  await recordExecutionEvidence({
    executionItemId: top.item.id,
    sourceType: envelope.sourceType,
    sourceLocator: envelope.sourceLocator,
    relationship: kind === "completion" ? "supports_completion" : "supports_cancellation",
    excerpt: signal?.excerpt ?? envelope.excerpt,
    occurredAt: envelope.occurredAt,
  });

  // Never applied automatically -- always routed to review (Brief Part
  // 4.E: "ambiguous AI-detected completion should generally produce a
  // review/attention proposal rather than silently close important work";
  // Part 20: cancellation "should require strong evidence or review").
  const outcome: ReconciliationOutcome = kind === "completion" ? "propose_completion" : "propose_cancellation";
  const attention = await createReconciliationAttentionItem({
    kind: kind === "completion" ? "proposed_completion" : "proposed_cancellation",
    executionItemId: top.item.id,
    title: `${kind === "completion" ? "Mark complete?" : "Cancel?"} "${top.item.title}"`,
    detail: `Evidence: "${signal?.excerpt ?? envelope.excerpt}" (match confidence ${top.score.toFixed(2)})`,
    dedupeKey: `reconciliation:${outcome}:${top.item.id}`,
    payload: { score: top.score, excerpt: signal?.excerpt },
  });

  await recordReconciliationDecision(traceId, {
    runId,
    evidenceRef: { attentionItemId: attention.id },
    outcome,
    matchedExecutionItemId: top.item.id,
    confidence: top.score,
    matchBasis: `title similarity ${top.score.toFixed(2)} to "${top.item.title}"`,
    automatic: true,
    reasoningSummary: `${kind === "completion" ? "Completion" : "Cancellation"} evidence for "${top.item.title}" (similarity ${top.score.toFixed(2)}); proposed for review, not applied automatically.`,
  });
  return { outcome, executionItemId: top.item.id };
}

/**
 * Phase 5 Calendar: updates timing on an item CONFIRMED (by identity, via
 * matchCandidates.findConfirmedCalendarLink -- not by semantic matching)
 * to be linked to this calendar event. Skips the ownership gate and
 * candidate scoring entirely, on purpose: reconcileEnvelope's normal path
 * answers "does this evidence belong to some item," which doesn't apply
 * here -- the caller already knows exactly which item this event maps to.
 * Still writes through the same shared evidence/decision tables as every
 * other outcome, per Brief Part 9. A no-op (returns "no_action", no
 * writes) if the timing hasn't actually changed.
 */
export async function applyConfirmedTimingUpdate(params: {
  item: CandidateExecutionItem;
  newTiming: { kind: "must" | "target"; at: string };
  sourceType: EvidenceSourceType;
  sourceLocator: SourceLocator;
  excerpt: string;
  occurredAt: string;
  runId: string;
  traceId: string | null;
}): Promise<ReconcileResult> {
  if (params.item.timingAt === params.newTiming.at) {
    return { outcome: "no_action", executionItemId: null };
  }

  const { error } = await supabaseServer
    .from("execution_items")
    .update({ timing_at: params.newTiming.at, timing_kind: params.newTiming.kind, updated_at: new Date().toISOString() })
    .eq("id", params.item.id);
  if (error) {
    throw new Error(`Could not update timing on confirmed-linked execution item: ${error.message}`);
  }

  // A rescheduled event has exactly one "current" timing assertion, not a
  // growing history -- unlike recordExecutionEvidence's normal
  // ignore-on-conflict semantics (each source message is immutable, so a
  // repeat is a no-op), this must overwrite the prior occurred_at/excerpt
  // for the same (item, source, locator, relationship) tuple or the
  // evidence trail would keep citing the meeting's original time forever.
  const { error: evidenceError } = await supabaseServer.from("execution_evidence").upsert(
    {
      execution_item_id: params.item.id,
      source_type: params.sourceType,
      source_locator: params.sourceLocator,
      relationship: "supports_timing",
      excerpt: params.excerpt,
      occurred_at: params.occurredAt,
    },
    { onConflict: "execution_item_id,source_type,source_locator,relationship" }
  );
  if (evidenceError) {
    throw new Error(`Could not record timing-update evidence: ${evidenceError.message}`);
  }

  await recordReconciliationDecision(params.traceId, {
    runId: params.runId,
    evidenceRef: { executionItemId: params.item.id },
    outcome: "update_timing",
    matchedExecutionItemId: params.item.id,
    confidence: 1,
    matchBasis: "confirmed prior link (identity, not semantic match)",
    automatic: true,
    reasoningSummary: `Event linked to "${params.item.title}" was rescheduled; timing updated to ${params.newTiming.at}.`,
  });

  return { outcome: "update_timing", executionItemId: params.item.id };
}

/**
 * Phase 5 Calendar: a meeting CONFIRMED linked to an open item was
 * cancelled. This does NOT cancel the item -- a cancelled meeting can mean
 * the timing changed, the work is deferred, or it's genuinely no longer
 * needed, and only a human knows which (Brief Part 3.C). Always routes to
 * review, mirroring the existing completion/cancellation review policy
 * exactly (never a separate, weaker Calendar-specific policy).
 */
export async function applyConfirmedCancellationReview(params: {
  item: CandidateExecutionItem;
  sourceType: EvidenceSourceType;
  sourceLocator: SourceLocator;
  excerpt: string;
  occurredAt: string;
  runId: string;
  traceId: string | null;
}): Promise<ReconcileResult> {
  await recordExecutionEvidence({
    executionItemId: params.item.id,
    sourceType: params.sourceType,
    sourceLocator: params.sourceLocator,
    relationship: "supports_cancellation",
    excerpt: params.excerpt,
    occurredAt: params.occurredAt,
  });

  const attention = await createReconciliationAttentionItem({
    kind: "proposed_cancellation",
    executionItemId: params.item.id,
    title: `Linked meeting cancelled -- still needed? "${params.item.title}"`,
    detail: `The calendar event linked to this item was cancelled. This may mean the work changed timing, was deferred, or is no longer needed -- not applied automatically. Evidence: "${params.excerpt}"`,
    dedupeKey: `reconciliation:calendar_cancellation:${params.item.id}`,
    payload: { excerpt: params.excerpt },
  });

  await recordReconciliationDecision(params.traceId, {
    runId: params.runId,
    evidenceRef: { attentionItemId: attention.id },
    outcome: "propose_cancellation",
    matchedExecutionItemId: params.item.id,
    confidence: 1,
    matchBasis: "confirmed prior link (identity, not semantic match)",
    automatic: true,
    reasoningSummary: `Meeting linked to "${params.item.title}" was cancelled; routed for review rather than cancelling the item automatically.`,
  });

  return { outcome: "propose_cancellation", executionItemId: params.item.id };
}
