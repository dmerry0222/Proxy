import { propositionSimilarity } from "./claimReconciliationRules.ts";

/**
 * Pure, zero-DB-import leaf module deciding whether a pending_context item
 * needs Dave's review, the same "explicit review-worthiness" philosophy as
 * claimReviewPolicy.ts. Derived from an actual audit of the live backlog
 * (Aug/Sep 2026): 173 pending items, 88 waiting_on + 74 follow_up (94%),
 * with the remaining 11 (deferred_idea/future_trigger/performance_note/
 * reminder_context) containing exact/near-duplicate clusters produced by
 * calendar/Teams reconciliation processing the same event from multiple
 * angles seconds apart. Unlike claims, pending_context does NOT skew
 * uniformly toward over-review -- follow_up/waiting_on are exactly the
 * "consequential" categories Dave wants kept in front of him, so this
 * policy is deliberately narrower than claimReviewPolicy: only demonstrably
 * passive/observational types, absent any consequence cue, auto-save.
 */

export type PendingContextReviewOutcome =
  | "auto_save"
  | "review_required"
  | "stale_or_expired"
  | "duplicate_or_superseded";

export type PendingContextReviewResult = {
  outcome: PendingContextReviewOutcome;
  reason: string;
};

/**
 * Inherently action/decision-shaped by their own type definition -- these
 * are exactly what Dave described as review-worthy (consequential
 * waiting_on, important follow-ups). "other" is an unclassified escape
 * hatch and stays conservative alongside them.
 */
const ALWAYS_REVIEW_TYPES = new Set(["follow_up", "waiting_on", "other"]);

/**
 * Passive/observational by their own type definition: a deferred idea,
 * minor tweak, gift idea, a fact to remember, or a note about how
 * something went. None of these imply Dave owes a response or decision --
 * that's what distinguishes them from follow_up/waiting_on above. Still
 * checked against the consequence-cue pattern below as a defensive
 * second layer, since a type alone can mislabel content.
 */
const PASSIVE_TYPES = new Set(["deferred_idea", "tweak", "gift_idea", "reminder_context", "performance_note"]);

/**
 * "future_trigger" is deliberately NOT bucketed with either group above --
 * Dave's own examples split it ("low-stakes future triggers" vs. "high-
 * impact future triggers"), so it's judged purely by the consequence-cue
 * check, same as the defensive check on PASSIVE_TYPES.
 */
const CONSEQUENCE_CUE_PATTERN =
  /\b(respond by|reply by|rsvp|deadline|due by|due date|must confirm|confirm by|approve by|decide by|expir\w*|final notice|urgent|asap|time.?sensitive|required by|before (?:the )?(?:end of|eod|cob))\b/i;

/** No pending_context item in the live backlog is older than ~9 days as of this policy's introduction; this exists for future-proofing, not because it fires today. */
const STALE_AGE_DAYS = 30;

export type PendingContextReviewInput = {
  contextType: string;
  summary: string;
  detail: string | null;
  createdAt: string;
  expiresAt: string | null;
  now?: Date;
};

export function assessPendingContextReviewTier(input: PendingContextReviewInput): PendingContextReviewResult {
  const now = input.now ?? new Date();

  if (input.expiresAt && new Date(input.expiresAt).getTime() < now.getTime()) {
    return { outcome: "stale_or_expired", reason: "Past its explicit expiration." };
  }

  if (ALWAYS_REVIEW_TYPES.has(input.contextType)) {
    return { outcome: "review_required", reason: `context_type "${input.contextType}" is inherently action/decision-shaped.` };
  }

  const text = `${input.summary} ${input.detail ?? ""}`;
  if (CONSEQUENCE_CUE_PATTERN.test(text)) {
    return { outcome: "review_required", reason: "Matched a consequence/deadline cue despite a low-risk-shaped type." };
  }

  const ageDays = (now.getTime() - new Date(input.createdAt).getTime()) / 86_400_000;
  if (ageDays > STALE_AGE_DAYS) {
    return { outcome: "stale_or_expired", reason: `Older than ${STALE_AGE_DAYS} days with no resolution.` };
  }

  if (PASSIVE_TYPES.has(input.contextType) || input.contextType === "future_trigger") {
    return {
      outcome: "auto_save",
      reason: `Low-risk context_type "${input.contextType}" with no consequence cues -- kept provisionally.`,
    };
  }

  // Unknown/unlisted context_type: conservative default.
  return { outcome: "review_required", reason: `Unrecognized context_type "${input.contextType}"; defaulting to review.` };
}

export type PendingContextForDuplicateCheck = {
  id: string;
  entityId: string | null;
  contextType: string;
  summary: string;
  detail: string | null;
  createdAt: string;
};

/**
 * Two different bars, not one. For follow_up/waiting_on/other -- the types
 * Dave wants kept conservative -- a live-backlog spot check found that a
 * loose similarity bar (0.6) sometimes conflated a genuine PROGRESSION of
 * the same thread ("waiting for X to propose a time" vs. "meeting with X
 * scheduled") with a true duplicate. Collapsing that pair is backwards --
 * it can retire the more current fact in favor of the staler one, since
 * the earlier-created item is kept as canonical. Requiring near-verbatim
 * wording (0.82, the same bar claimReconciliationRules.ts uses for
 * duplicates_existing) all but eliminates that risk: a real duplicate
 * (the same fact extracted twice from the same event) is worded almost
 * identically, while a progression naturally reads differently. Passive
 * types keep the looser bar -- a false-positive merge there is genuinely
 * low-stakes either way.
 */
const HIGH_STAKES_DUPLICATE_THRESHOLD = 0.82;
const LOW_STAKES_DUPLICATE_THRESHOLD = 0.6;
const HIGH_STAKES_TYPES_FOR_DUPLICATES = new Set(["follow_up", "waiting_on", "other"]);

/**
 * Detects near-duplicate pending-context items about the same entity
 * created close together in time -- the exact shape of the duplicates
 * found in the live backlog (e.g. two near-identical "X will present at Y"
 * future_triggers 9 seconds apart from calendar reconciliation processing
 * one event twice). Returns a map of duplicate id -> canonical survivor id
 * (the earliest of the cluster). Deliberately requires the SAME entity --
 * two different people's genuinely separate asks are never coalesced.
 */
export function findDuplicatePendingContext(
  items: PendingContextForDuplicateCheck[],
  options: { withinHours?: number } = {}
): Map<string, string> {
  const withinMs = (options.withinHours ?? 24) * 3_600_000;

  const sorted = [...items].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const duplicateOf = new Map<string, string>();

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (!item.entityId || duplicateOf.has(item.id)) continue;

    for (let j = 0; j < i; j++) {
      const earlier = sorted[j];
      if (!earlier.entityId || earlier.entityId !== item.entityId) continue;
      if (duplicateOf.has(earlier.id)) continue; // compare only against a surviving canonical item

      const msApart = new Date(item.createdAt).getTime() - new Date(earlier.createdAt).getTime();
      if (msApart > withinMs) continue;

      const threshold =
        HIGH_STAKES_TYPES_FOR_DUPLICATES.has(item.contextType) || HIGH_STAKES_TYPES_FOR_DUPLICATES.has(earlier.contextType)
          ? HIGH_STAKES_DUPLICATE_THRESHOLD
          : LOW_STAKES_DUPLICATE_THRESHOLD;

      const similarity = propositionSimilarity(
        `${item.summary} ${item.detail ?? ""}`,
        `${earlier.summary} ${earlier.detail ?? ""}`
      );
      if (similarity >= threshold) {
        duplicateOf.set(item.id, earlier.id);
        break;
      }
    }
  }

  return duplicateOf;
}
