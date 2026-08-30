import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { createReconciliationAttentionItem } from "@/lib/reconciliation/attention";
import { isOverdue } from "@/lib/execute/reviewTransitions";

/**
 * Post-Phase-5 Part 16: make overdue externally-owned obligations visible
 * without manufacturing a "remind Sarah" task. Dedupe key includes
 * expected_at itself, not just the item id -- once Dave resolves an
 * escalation, the SAME expected date never re-alerts (no repeated daily
 * alerts), but a later, corrected expected_at that also lapses can still
 * raise a fresh one.
 */
export async function ensureOverdueExternalAttention(): Promise<void> {
  const { data, error } = await supabaseServer
    .from("execution_items")
    .select("id, title, expected_at, related_person_entity_id")
    .eq("responsibility", "external")
    .eq("status", "active")
    .not("expected_at", "is", null);
  if (error) throw new Error(`Could not check overdue external work: ${error.message}`);

  const overdue = (data ?? []).filter((row) => isOverdue(row.expected_at));
  if (!overdue.length) return;

  const personIds = [...new Set(overdue.map((row) => row.related_person_entity_id).filter((id): id is string => Boolean(id)))];
  const { data: people } = personIds.length
    ? await supabaseServer.from("memory_entities").select("id, canonical_name").in("id", personIds)
    : { data: [] as { id: string; canonical_name: string }[] };
  const names = new Map((people ?? []).map((person) => [person.id, person.canonical_name]));

  for (const row of overdue) {
    const who = row.related_person_entity_id ? names.get(row.related_person_entity_id) ?? "someone" : "someone";
    const days = Math.max(1, Math.floor((Date.now() - new Date(row.expected_at as string).getTime()) / 86_400_000));
    await createReconciliationAttentionItem({
      kind: "waiting_overdue",
      executionItemId: row.id,
      title: `Waiting on ${who} — ${row.title}`,
      detail: `Expected ${new Date(row.expected_at as string).toLocaleDateString()} · ${days} day${days === 1 ? "" : "s"} overdue`,
      dedupeKey: `reconciliation:waiting_overdue:${row.id}:${row.expected_at}`,
      payload: { expectedAt: row.expected_at },
    });
  }
}
