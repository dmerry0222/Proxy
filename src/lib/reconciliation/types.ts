/**
 * Shared types for the Action Reconciliation Layer. Source processors
 * (email, Teams, calendar, artifacts) build an ActionEvidenceEnvelope and
 * hand it to the reconciler rather than deciding Execute state themselves.
 */

export type EvidenceSourceType =
  | "document_section"
  | "email"
  | "teams_message"
  | "calendar_event"
  | "memory_evidence"
  | "user_action";

export type SourceLocator =
  | { section_id: string }
  | { outlook_message_id: string }
  /** Anchored to the first message in the cited range -- the full range lives in envelope.metadata.messageIds, not the locator, so the locator stays a stable idempotency key across reprocessing. */
  | { teams_message_id: string; chat_id: string }
  | { calendar_event_id: string; run_guid?: string | null }
  | { memory_evidence_id: string }
  | { actor: string; action: string };

export type EvidenceRelationship =
  | "supports_creation"
  | "supports_ownership"
  | "supports_timing"
  | "supports_external_owner"
  | "supports_completion"
  | "supports_cancellation"
  | "supports_project"
  | "contradicts"
  | "supersedes";

/**
 * The three ownership bases extractMeetingKnowledge.ts and
 * interpretGenericArtifact.ts each currently declare independently (see
 * ownershipRules.ts, which consolidates them) plus two new ones for
 * externally-owned work. "uncertain ownership means no task" governs all
 * five -- see ownershipRules.ts for the actual gate.
 */
export type OwnershipBasis =
  | "explicit_assignment_to_dave"
  | "explicit_acceptance_by_dave"
  | "explicit_user_intent"
  | "explicit_external_commitment"
  | "explicit_external_assignment";

export type ActorRef = {
  entityId: string | null;
  email: string | null;
  name: string | null;
};

export type OwnershipEvidence =
  | { owner: "dave"; basis: OwnershipBasis; excerpt: string }
  | { owner: "external"; actor: ActorRef; basis: OwnershipBasis; excerpt: string }
  | { owner: "ambiguous" };

export type TimingEvidence = {
  kind: "must" | "target";
  at: string;
  basis: string;
} | null;

export type ProjectHint = {
  memoryProjectEntityId: string;
  basis: string;
} | null;

export type CompletionEvidence = {
  likely: boolean;
  basis: string;
  excerpt: string;
} | null;

export type CancellationEvidence = {
  likely: boolean;
  basis: string;
  excerpt: string;
} | null;

/**
 * The common action-evidence envelope (Brief Part 8). One envelope
 * represents one piece of evidence that might change operational state --
 * not necessarily one execution item. Multiple envelopes from different
 * sources can resolve to the same item via matching (matchCandidates.ts).
 */
export type ActionEvidenceEnvelope = {
  sourceType: EvidenceSourceType;
  sourceLocator: SourceLocator;
  occurredAt: string;
  actors: ActorRef[];
  excerpt: string;
  candidateTitle: string | null;
  ownership: OwnershipEvidence;
  timing: TimingEvidence;
  projectHint: ProjectHint;
  completion: CompletionEvidence;
  cancellation: CancellationEvidence;
  metadata?: Record<string, unknown>;
};

export type ReconciliationOutcome =
  | "create_dave_item"
  | "create_external_item"
  | "attach_evidence"
  | "update_timing"
  | "propose_completion"
  | "complete"
  | "propose_cancellation"
  | "cancel"
  | "associate_project"
  | "nominate_project"
  | "pending_context_only"
  | "no_action"
  | "ambiguous_review";

export type ReconciliationTrigger = "forward" | "backfill" | "manual_replay";

export type ReconciliationDecisionInput = {
  runId: string;
  evidenceRef: Record<string, unknown>;
  outcome: ReconciliationOutcome;
  matchedExecutionItemId?: string | null;
  confidence?: number | null;
  ownershipBasis?: string | null;
  matchBasis?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  modelVersion?: string | null;
  automatic: boolean;
  /** Concise operational justification -- not chain-of-thought. E.g. "Explicit
   * first-person commitment by Dave; matched existing item by project, object,
   * and recipient." */
  reasoningSummary: string;
};
