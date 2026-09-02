import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { assessCuration, type CurationInput } from "@/lib/execute/curationPolicy";

/**
 * Applies curationPolicy.ts to every execution item and writes the result
 * back onto the row (curated / why_surfaced / why_suppressed /
 * last_assessed_at), so both Notion views and any future reader see the same
 * answer without re-deriving it -- and so the reason is attached to the item
 * itself rather than living only in code.
 *
 * Writes are skipped when nothing changed, which keeps updated_at stable and
 * therefore keeps the Notion canonical-hash skip effective: a sweep that
 * changes no curation decisions produces no Notion traffic at all.
 *
 * why_surfaced is a two-writer field by design: Mailroom intake stamps its
 * own provenance sentence on creation ("Proxy classified it Needs
 * Attention"), and curation overwrites it with the current reason the item is
 * on the curated surface. Both answer "why am I looking at this?", and the
 * fresher answer is the useful one; the original classification survives in
 * metadata and in execution_evidence.
 */

const PAGE_SIZE = 500;

export type CurationRefreshSummary = {
  assessed: number;
  curated: number;
  suppressed: number;
  changed: number;
};

type ItemRow = {
  id: string;
  status: string;
  responsibility: string;
  priority_tier: string | null;
  confirmed_by_user: boolean;
  timing_at: string | null;
  timing_kind: string | null;
  planned_at: string | null;
  deferred_until: string | null;
  expected_at: string | null;
  related_person_entity_id: string | null;
  source_system: string | null;
  source_withdrawn_at: string | null;
  project_state_id: string | null;
  created_at: string;
  curated: boolean;
  why_surfaced: string | null;
  why_suppressed: string | null;
  metadata: Record<string, unknown> | null;
};

function sourceOccurredAt(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.source_occurred_at;
  return typeof value === "string" ? value : null;
}

export async function refreshExecuteCuration(): Promise<CurationRefreshSummary> {
  const summary: CurationRefreshSummary = { assessed: 0, curated: 0, suppressed: 0, changed: 0 };
  const now = new Date();
  const assessedAt = now.toISOString();

  const rows: ItemRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("execution_items")
      .select(
        "id, status, responsibility, priority_tier, confirmed_by_user, timing_at, timing_kind, planned_at, deferred_until, expected_at, related_person_entity_id, source_system, source_withdrawn_at, project_state_id, created_at, curated, why_surfaced, why_suppressed, metadata"
      )
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Could not load execution items for curation: ${error.message}`);
    rows.push(...((data ?? []) as ItemRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const personIds = [...new Set(rows.map((row) => row.related_person_entity_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string>();
  if (personIds.length) {
    const { data, error } = await supabaseServer
      .from("memory_entities")
      .select("id, canonical_name")
      .in("id", personIds);
    if (error) throw new Error(`Could not load related people for curation: ${error.message}`);
    for (const person of data ?? []) names.set(person.id, person.canonical_name);
  }

  for (const row of rows) {
    const input: CurationInput = {
      status: row.status,
      responsibility: row.responsibility,
      priorityTier: row.priority_tier,
      confirmedByUser: row.confirmed_by_user,
      timingAt: row.timing_at,
      timingKind: row.timing_kind,
      plannedAt: row.planned_at,
      deferredUntil: row.deferred_until,
      expectedAt: row.expected_at,
      waitingOnName: row.related_person_entity_id ? names.get(row.related_person_entity_id) ?? null : null,
      sourceSystem: row.source_system,
      sourceWithdrawnAt: row.source_withdrawn_at,
      projectStateId: row.project_state_id,
      createdAt: row.created_at,
      sourceOccurredAt: sourceOccurredAt(row.metadata),
      now,
    };

    const result = assessCuration(input);
    summary.assessed += 1;
    if (result.curated) summary.curated += 1;
    else summary.suppressed += 1;

    const unchanged =
      row.curated === result.curated &&
      row.why_surfaced === result.whySurfaced &&
      row.why_suppressed === result.whySuppressed;

    if (unchanged) continue;

    const { error } = await supabaseServer
      .from("execution_items")
      .update({
        curated: result.curated,
        why_surfaced: result.whySurfaced,
        why_suppressed: result.whySuppressed,
        last_assessed_at: assessedAt,
      })
      .eq("id", row.id);

    if (error) throw new Error(`Could not update curation for item ${row.id}: ${error.message}`);
    summary.changed += 1;
  }

  return summary;
}
