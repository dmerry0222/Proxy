import "server-only";

import {
  supabaseServer,
} from "@/lib/supabase/server";

import type {
  MemoryEntityContext,
} from "@/lib/memory/types";

type RawMemoryContext = {
  entity: {
    id: string;
    name: string;
    type:
      MemoryEntityContext["entity"]["type"];
    status: string;
    visibility: string;
    description:
      string | null;
  };

  generated_at: string;

  current_claims: Array<{
    id: string;
    type: string;
    statement: string;

    valid_from:
      string | null;

    valid_to:
      string | null;

    learned_at:
      string;

    visibility:
      string;

    evidence_strength:
      MemoryEntityContext["currentClaims"][number]["evidenceStrength"];

    confirmed_by_user:
      boolean;

    is_governing_context:
      boolean;

    supporting_evidence_count:
      number;

    independent_source_count:
      number;
  }>;

  pending_context: Array<{
    id: string;
    type: string;
    summary: string;
    detail:
      string | null;

    status:
      string;

    trigger_type:
      string | null;

    trigger_at:
      string | null;

    expires_at:
      string | null;

    visibility:
      string;
  }>;

  review_items: Array<{
    id: string;
    type: string;
    title: string;

    prompt:
      string | null;

    priority:
      number;

    claim_id:
      string | null;

    pending_context_id:
      string | null;

    options:
      string[];
  }>;
};

export async function getMemoryEntityContext(
  entityId: string
): Promise<MemoryEntityContext | null> {
  const {
    data,
    error,
  } = await supabaseServer.rpc(
    "get_memory_entity_context",
    {
      target_entity_id:
        entityId,
    }
  );

  if (error) {
    throw new Error(
      `Failed to load Memory context: ${error.message}`
    );
  }

  if (!data) {
    return null;
  }

  const raw =
    data as RawMemoryContext;

  return {
    entity:
      raw.entity,

    generatedAt:
      raw.generated_at,

    currentClaims:
      raw.current_claims.map(
        (claim) => ({
          id:
            claim.id,

          type:
            claim.type,

          statement:
            claim.statement,

          validFrom:
            claim.valid_from,

          validTo:
            claim.valid_to,

          learnedAt:
            claim.learned_at,

          visibility:
            claim.visibility,

          evidenceStrength:
            claim.evidence_strength,

          confirmedByUser:
            claim.confirmed_by_user,

          isGoverningContext:
            claim.is_governing_context,

          supportingEvidenceCount:
            claim.supporting_evidence_count,

          independentSourceCount:
            claim.independent_source_count,
        })
      ),

    pendingContext:
      raw.pending_context.map(
        (item) => ({
          id:
            item.id,

          type:
            item.type,

          summary:
            item.summary,

          detail:
            item.detail,

          status:
            item.status,

          triggerType:
            item.trigger_type,

          triggerAt:
            item.trigger_at,

          expiresAt:
            item.expires_at,

          visibility:
            item.visibility,
        })
      ),

    reviewItems:
      raw.review_items.map(
        (item) => ({
          id:
            item.id,

          type:
            item.type,

          title:
            item.title,

          prompt:
            item.prompt,

          priority:
            item.priority,

          claimId:
            item.claim_id,

          pendingContextId:
            item.pending_context_id,

          options:
            item.options ?? [],
        })
      ),
  };
}