import type { OwnershipBasis, OwnershipEvidence } from "./types";

/**
 * Consolidates the ownership-basis set that src/lib/ingestion/
 * extractMeetingKnowledge.ts and interpretGenericArtifact.ts each currently
 * declare as independent `Set` literals (found to have drifted slightly
 * from their own prompt text during Phase 1 inspection). Phase 2's refactor
 * should point both files at this constant instead of their own copies.
 *
 * "Uncertain ownership means no task" is the governing rule: a Dave item
 * may only be created when evidence matches one of these bases AND carries
 * a non-empty supporting excerpt. Never infer Dave ownership from
 * importance, broad job-domain relevance, meeting attendance, group
 * addressing, or passive voice.
 */
export const DAVE_OWNERSHIP_BASES: ReadonlySet<OwnershipBasis> = new Set([
  "explicit_assignment_to_dave",
  "explicit_acceptance_by_dave",
  "explicit_user_intent",
]);

/**
 * External ownership requires the same rigor: another identifiable person
 * clearly committed to or was assigned the work, not merely mentioned in
 * connection with it.
 */
export const EXTERNAL_OWNERSHIP_BASES: ReadonlySet<OwnershipBasis> = new Set([
  "explicit_external_commitment",
  "explicit_external_assignment",
]);

export function isDaveOwnershipBasis(basis: string | null | undefined): basis is OwnershipBasis {
  return Boolean(basis) && DAVE_OWNERSHIP_BASES.has(basis as OwnershipBasis);
}

export function isExternalOwnershipBasis(basis: string | null | undefined): basis is OwnershipBasis {
  return Boolean(basis) && EXTERNAL_OWNERSHIP_BASES.has(basis as OwnershipBasis);
}

/** True only when evidence clears the bar for a Dave-owned execution candidate. */
export function gatesDaveOwnership(ownership: OwnershipEvidence): ownership is Extract<OwnershipEvidence, { owner: "dave" }> {
  return (
    ownership.owner === "dave" &&
    isDaveOwnershipBasis(ownership.basis) &&
    Boolean(ownership.excerpt?.trim())
  );
}

/** True only when evidence clears the bar for externally-owned/waiting-on state. */
export function gatesExternalOwnership(
  ownership: OwnershipEvidence
): ownership is Extract<OwnershipEvidence, { owner: "external" }> {
  return (
    ownership.owner === "external" &&
    isExternalOwnershipBasis(ownership.basis) &&
    Boolean(ownership.excerpt?.trim()) &&
    Boolean(ownership.actor.entityId || ownership.actor.email)
  );
}
