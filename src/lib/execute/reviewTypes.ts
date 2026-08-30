export type ReviewEntryType =
  | "dave_candidate"
  | "external_candidate"
  | "completion_proposal"
  | "cancellation_proposal"
  | "ambiguous_match"
  | "waiting_overdue"
  | "project_nomination";

export type EvidenceEntry = {
  id: string;
  sourceType: string;
  relationship: string;
  excerpt: string | null;
  occurredAt: string | null;
  personName: string | null;
  sourceLocator: Record<string, unknown>;
};

/**
 * One unresolved operational judgment, regardless of which reconciliation
 * outcome produced it. This is the row shape the Reconciliation Review UI
 * renders -- it deliberately does not distinguish "which source found
 * this" (Post-Phase-5 Part 18: one operational item, not per-source tasks).
 */
export type ReviewEntry = {
  id: string;
  type: ReviewEntryType;
  attentionItemId: string | null;
  executionItemId: string | null;
  title: string;
  detail: string | null;
  createdAt: string;
  // Present when this entry concerns an existing execution item (candidate
  // review, completion/cancellation proposal, the "possible existing item"
  // side of an ambiguous match).
  item: {
    id: string;
    title: string;
    status: string;
    responsibility: "mine" | "external";
    timingAt: string | null;
    timingKind: "must" | "target" | null;
    relatedPersonName: string | null;
    expectedAt: string | null;
    waitingSince: string | null;
    obligationContext: string | null;
    projectName: string | null;
  } | null;
  // Ambiguous-match-only: the incoming evidence proposing a possible new
  // item, shown alongside `item` (the possible existing match).
  proposedTitle: string | null;
  matchScore: number | null;
  matchBasis: string | null;
  evidenceExcerpt: string | null;
};

export type ReconciliationReviewData = {
  entries: ReviewEntry[];
};
