/**
 * Pure leaf module deciding whether a reconciled Memory claim
 * should auto-save or go to human review -- the "tiered review policy"
 * this module exists to make explicit and testable, replacing what used
 * to be an implicit default: every claim outcome except a rule/model
 * match against an existing claim (supports_existing/duplicates_existing)
 * created a memory_review_items row, regardless of stakes.
 *
 * Philosophy: Memory can believe lots of small things provisionally. Dave
 * should only have to referee the ones where being wrong matters.
 */

import { assessClaimConsequence } from "./claimConsequencePolicy.ts";

export type ClaimReviewTier = "auto_save" | "review";

export type ClaimReviewTierResult = {
  tier: ClaimReviewTier;
  reason: string;
};

export type ExistingClaimRiskContext = {
  claimType: string;
  confirmedByUser: boolean;
  isGoverningContext: boolean;
};

export type ClaimReviewTierInput = {
  claimType: string;
  statement: string;
  evidenceStrength: "weak" | "moderate" | "strong" | "confirmed" | null;
  /** The reconciliation outcome that led here -- "new", "refines_existing", "contradicts_existing", or "supersedes_existing". */
  relationship: "new" | "refines_existing" | "contradicts_existing" | "supersedes_existing";
  /** The existing claim this outcome relates to, when relationship isn't "new". */
  existingClaim: ExistingClaimRiskContext | null;
};

/**
 * Claim types that are, BY THEIR NATURE, easy to supersede later and
 * unlikely to materially affect a major Proxy decision: communication
 * preferences, soft working habits, recurring meeting patterns, project
 * associations, minor status/milestone notes. Everything else (fact,
 * relationship, decision, other) defaults to review -- these can each be
 * trivial OR consequential depending on content, and claim_type alone
 * can't tell them apart, so caution wins.
 */
const LOW_RISK_CLAIM_TYPES = new Set(["preference", "working_context", "project_association", "status", "milestone"]);

/**
 * Always review, regardless of evidence strength: durable
 * ownership/reporting claims (role/responsibility already pass through an
 * extra explicit-ownership-signal gate upstream in ingestEmail.ts, but
 * that gates EXTRACTION, not review-worthiness) and governing context,
 * which is foundational by definition (memory_claims.is_governing_context
 * exists as its own concept for exactly this reason).
 */
const ALWAYS_REVIEW_CLAIM_TYPES = new Set(["role", "responsibility", "governing_context"]);

/**
 * The only types whose review-worthiness is decided by CONTENT rather than
 * by type. Kept as an explicit set (rather than "everything not otherwise
 * matched") so widening it is always a deliberate, visible edit.
 */
const CONSEQUENCE_ASSESSED_CLAIM_TYPES = new Set(["fact", "decision"]);

/**
 * Sensitive/high-impact topics that must never be auto-saved regardless
 * of claim_type. Deliberately broad and conservative -- false positives
 * here just mean an extra (appropriate) review item, not a missed one.
 */
const SENSITIVE_KEYWORD_PATTERN =
  /\b(health|medical|diagnos\w*|illness|therapy|mental health|disabilit\w*|pregnan\w*|salary|compensation|payroll|raise|bonus|terminat\w*|fired|laid off|layoff|resign\w*|lawsuit|legal action|litigation|harass\w*|discriminat\w*|complaint filed|grievance|confidential|\bssn\b|social security|home address|personal phone|passport|visa status|immigration)\b/i;

export function assessClaimReviewTier(input: ClaimReviewTierInput): ClaimReviewTierResult {
  if (ALWAYS_REVIEW_CLAIM_TYPES.has(input.claimType)) {
    return { tier: "review", reason: `claim_type "${input.claimType}" always requires review.` };
  }

  if (input.evidenceStrength === "weak" || input.evidenceStrength === null) {
    return { tier: "review", reason: "Evidence is too weak to auto-save; supported by at least reasonable evidence is required." };
  }

  if (SENSITIVE_KEYWORD_PATTERN.test(input.statement)) {
    return { tier: "review", reason: "Statement matched a sensitive-topic keyword." };
  }

  if (input.existingClaim) {
    if (input.existingClaim.confirmedByUser) {
      return { tier: "review", reason: "Would affect a claim Dave already confirmed." };
    }
    if (input.existingClaim.isGoverningContext) {
      return { tier: "review", reason: "Would affect governing context." };
    }
    if (ALWAYS_REVIEW_CLAIM_TYPES.has(input.existingClaim.claimType)) {
      return { tier: "review", reason: `Would affect an existing "${input.existingClaim.claimType}" claim.` };
    }
  } else if (input.relationship === "contradicts_existing" || input.relationship === "supersedes_existing") {
    // Defensive: these outcomes should always carry a resolved existing
    // claim. If one is missing, be conservative rather than guess.
    return { tier: "review", reason: "Contradiction/supersession without a resolvable prior claim." };
  }

  /*
   * Consequence gate for `fact` and `decision` only. These two types were
   * measured (read-only audit of the pending queue) to span the full
   * stakes range, so type alone over-reviews them badly. Everything above
   * this point still applies first -- sensitive keywords, weak evidence,
   * and any effect on a confirmed/governing/always-review claim have
   * already forced review before we get here, so this gate can only ever
   * relax a claim that already cleared every conservative check.
   *
   * Deliberately NOT extended to relationship/role/responsibility/
   * governing_context: those stay type-conservative because their content
   * (family details, reporting lines, ownership) is not something a
   * keyword list should be trusted to triage.
   */
  if (CONSEQUENCE_ASSESSED_CLAIM_TYPES.has(input.claimType)) {
    const consequence = assessClaimConsequence(input.statement);
    if (consequence.level === "low") {
      return {
        tier: "auto_save",
        reason: `Low-consequence "${input.claimType}" claim: ${consequence.reason}`,
      };
    }
    return { tier: "review", reason: `"${input.claimType}" claim: ${consequence.reason}` };
  }

  if (!LOW_RISK_CLAIM_TYPES.has(input.claimType)) {
    return { tier: "review", reason: `claim_type "${input.claimType}" is not in the low-risk auto-save set.` };
  }

  return {
    tier: "auto_save",
    reason: `Low-risk claim_type "${input.claimType}" with ${input.evidenceStrength} evidence and no high-risk signals.`,
  };
}
