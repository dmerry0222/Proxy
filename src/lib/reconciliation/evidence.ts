import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { EvidenceRelationship, EvidenceSourceType, SourceLocator } from "./types";

/**
 * Idempotently records one piece of evidence against an execution item.
 * Relies on execution_evidence's unique constraint on (execution_item_id,
 * source_type, source_locator, relationship) -- reprocessing the same
 * Outlook message / Teams message / calendar reconciliation / artifact
 * section against the same item and relationship is a no-op, not a
 * duplicate row. Returns `created: false` when the row already existed.
 */
export async function recordExecutionEvidence(input: {
  executionItemId: string;
  sourceType: EvidenceSourceType;
  sourceLocator: SourceLocator;
  relationship: EvidenceRelationship;
  excerpt?: string | null;
  occurredAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; created: boolean }> {
  const { data: inserted, error } = await supabaseServer
    .from("execution_evidence")
    .upsert(
      {
        execution_item_id: input.executionItemId,
        source_type: input.sourceType,
        source_locator: input.sourceLocator,
        relationship: input.relationship,
        excerpt: input.excerpt ?? null,
        occurred_at: input.occurredAt ?? null,
        metadata: input.metadata ?? {},
      },
      { onConflict: "execution_item_id,source_type,source_locator,relationship", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to record execution evidence: ${error.message}`);
  }

  if (inserted) {
    return { id: inserted.id as string, created: true };
  }

  // Conflict was ignored (row already existed) -- ignoreDuplicates doesn't
  // return the existing row, so fetch it explicitly for a stable id.
  const { data: existing, error: lookupError } = await supabaseServer
    .from("execution_evidence")
    .select("id")
    .eq("execution_item_id", input.executionItemId)
    .eq("source_type", input.sourceType)
    .eq("source_locator", JSON.stringify(input.sourceLocator))
    .eq("relationship", input.relationship)
    .maybeSingle();

  if (lookupError || !existing) {
    throw new Error(`Failed to load existing execution evidence: ${lookupError?.message ?? "not found"}`);
  }

  return { id: existing.id as string, created: false };
}
