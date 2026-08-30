import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { EvidenceEntry } from "@/lib/execute/reviewTypes";

/**
 * The compact evidence view for "why does Proxy think this?" (Post-Phase-5
 * Part 7) -- bounded excerpts and source context, not raw source_locator
 * JSON. Deeper technical detail (matching basis, run/trace ids, model
 * info) stays in Inspector General, reached via a separate drill-through
 * link, not duplicated here.
 */
export async function loadItemEvidence(executionItemId: string): Promise<EvidenceEntry[]> {
  const { data, error } = await supabaseServer
    .from("execution_evidence")
    .select("id, source_type, relationship, excerpt, occurred_at, source_locator, metadata")
    .eq("execution_item_id", executionItemId)
    .order("occurred_at", { ascending: true, nullsFirst: true });
  if (error) throw new Error(`Could not load evidence: ${error.message}`);

  const entityIds = [
    ...new Set(
      (data ?? [])
        .map((row) => (row.metadata as { entityId?: string } | null)?.entityId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const { data: people } = entityIds.length
    ? await supabaseServer.from("memory_entities").select("id, canonical_name").in("id", entityIds)
    : { data: [] as { id: string; canonical_name: string }[] };
  const names = new Map((people ?? []).map((person) => [person.id, person.canonical_name]));

  return (data ?? []).map((row) => {
    const metadata = (row.metadata ?? {}) as { entityId?: string };
    return {
      id: row.id,
      sourceType: row.source_type,
      relationship: row.relationship,
      excerpt: row.excerpt,
      occurredAt: row.occurred_at,
      personName: metadata.entityId ? names.get(metadata.entityId) ?? null : null,
      sourceLocator: row.source_locator as Record<string, unknown>,
    };
  });
}
