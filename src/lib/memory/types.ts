export type MemoryEntityType =
  | "person"
  | "project"
  | "organization"
  | "system";

export type MemoryEntity = {
  id: string;
  name: string;
  type: MemoryEntityType;
  status: string;
  visibility: string;
  description: string | null;
};

export type MemoryClaim = {
  id: string;
  type: string;
  statement: string;

  validFrom: string | null;
  validTo: string | null;
  learnedAt: string;

  visibility: string;

  evidenceStrength:
    | "weak"
    | "moderate"
    | "strong"
    | "confirmed"
    | null;

  confirmedByUser: boolean;
  isGoverningContext: boolean;

  supportingEvidenceCount: number;
  independentSourceCount: number;
};

export type MemoryPendingContext = {
  id: string;
  type: string;
  summary: string;
  detail: string | null;

  status: string;

  triggerType: string | null;
  triggerAt: string | null;
  expiresAt: string | null;

  visibility: string;
};

export type MemoryReviewItem = {
  id: string;
  type: string;
  title: string;
  prompt: string | null;

  priority: number;

  claimId: string | null;
  pendingContextId: string | null;

  options: string[];
};

export type MemoryEntityContext = {
  entity: MemoryEntity;
  generatedAt: string;

  currentClaims: MemoryClaim[];
  pendingContext: MemoryPendingContext[];
  reviewItems: MemoryReviewItem[];
};

export type MemoryEntityResolution = {
  entityId: string;
  entityType: MemoryEntityType;
  canonicalName: string;

  matchType:
    | "identifier"
    | "canonical_name";

  matchedValue: string;

  /**
   * Set only when resolveMemoryEntityByEmail just created this entity in
   * this call -- null for a match against a pre-existing identity. Lets
   * callers (e.g. ingestEmail.ts's Inspector General event) distinguish
   * "recognized an existing person" from "auto-seeded a new one," and
   * distinguish which deterministic bootstrap path created it.
   */
  seededFrom?: "org_chart" | "external_correspondence" | null;
};