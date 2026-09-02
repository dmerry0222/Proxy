import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import { reviewOptionsFor } from "@/lib/memory/reviewOptions";

export type MemoryReviewItem = {
  id: string;
  reviewType: string;

  title: string;
  prompt: string | null;

  priority: number;

  claimId: string | null;
  entityId: string | null;
  entityName: string | null;

  pendingContextId: string | null;

  options: string[];

  createdAt: string;
};

type ReviewRow = {
  id: string;
  review_type: string;

  title: string;
  prompt: string | null;

  priority: number;

  claim_id: string | null;
  entity_id: string | null;

  pending_context_id: string | null;

  payload: {
  options?: string[];
  calibration_set?: string;
} | null;

  defer_until: string | null;

  created_at: string;

};

export async function loadMemoryReviewItems(): Promise<
  MemoryReviewItem[]
> {
  const {
    data,
    error,
  } = await supabaseServer
    .from("memory_review_items")
    .select(`
      id,
      review_type,
      title,
      prompt,
      priority,
      claim_id,
      entity_id,
      pending_context_id,
      payload,
      defer_until,
      created_at
    `)
    .eq(
      "status",
      "pending"
    )
    .order(
      "priority",
      {
        ascending: false,
      }
    )
    .order(
      "created_at",
      {
        ascending: true,
      }
    );

  if (error) {
    throw new Error(
      `Could not load Memory Review items: ${error.message}`
    );
  }

  const now =
    new Date();

  const rows =
    (
      data ??
      []
    ) as ReviewRow[];

  /*
   * Deferred items stay pending in the database,
   * but disappear from the active review queue
   * until their defer date arrives.
   */
 const activeRows =
  rows.filter(
    (row) => {
      const isDeferred =
        row.defer_until &&
        new Date(row.defer_until) > now;

      const isCalibration =
        row.payload?.calibration_set ===
        "memory_v0_1";

      return (
        !isDeferred &&
        !isCalibration
      );
    }
  );

  const entityIds =
    [
      ...new Set(
        activeRows
          .map(
            (row) =>
              row.entity_id
          )
          .filter(
            (
              value
            ): value is string =>
              Boolean(
                value
              )
          )
      ),
    ];

  const entityNames =
    new Map<
      string,
      string
    >();

  if (
    entityIds.length >
    0
  ) {
    const {
      data:
        entities,
      error:
        entityError,
    } =
      await supabaseServer
        .from(
          "memory_entities"
        )
        .select(
          "id, canonical_name"
        )
        .in(
          "id",
          entityIds
        );

    if (
      entityError
    ) {
      throw new Error(
        `Could not load Memory entities for review: ${entityError.message}`
      );
    }

    for (
      const entity
      of entities ?? []
    ) {
      entityNames.set(
        entity.id,
        entity.canonical_name
      );
    }
  }

  return activeRows.map(
    (
      row
    ) => ({
      id:
        row.id,

      reviewType:
        row.review_type,

      title:
        row.title,

      prompt:
        row.prompt,

      priority:
        row.priority,

      claimId:
        row.claim_id,

      entityId:
        row.entity_id,

      entityName:
        row.entity_id
          ? entityNames.get(
              row.entity_id
            ) ??
            null
          : null,

      pendingContextId:
        row.pending_context_id,

      options:
        reviewOptionsFor(
          row.review_type,
          row.payload?.options
        ),

      createdAt:
        row.created_at,
    })
  );
}
