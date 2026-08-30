import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { ReconciliationReviewData, ReviewEntry } from "@/lib/execute/reviewTypes";

type ItemRow = {
  id: string;
  title: string;
  status: string;
  responsibility: "mine" | "external";
  timing_at: string | null;
  timing_kind: "must" | "target" | null;
  related_person_entity_id: string | null;
  expected_at: string | null;
  waiting_since: string | null;
  obligation_context: string | null;
  project_state_id: string | null;
  created_at: string;
};

async function loadItemContext(itemIds: string[]) {
  if (!itemIds.length) return { items: new Map<string, ItemRow>(), names: new Map<string, string>(), projects: new Map<string, string>() };

  const { data: items, error } = await supabaseServer
    .from("execution_items")
    .select("id, title, status, responsibility, timing_at, timing_kind, related_person_entity_id, expected_at, waiting_since, obligation_context, project_state_id, created_at")
    .in("id", itemIds);
  if (error) throw new Error(`Could not load review items: ${error.message}`);

  const rows = (items ?? []) as ItemRow[];
  const personIds = [...new Set(rows.map((row) => row.related_person_entity_id).filter((id): id is string => Boolean(id)))];
  const projectStateIds = [...new Set(rows.map((row) => row.project_state_id).filter((id): id is string => Boolean(id)))];

  const [{ data: people }, { data: projectStates }] = await Promise.all([
    personIds.length
      ? supabaseServer.from("memory_entities").select("id, canonical_name").in("id", personIds)
      : Promise.resolve({ data: [] as { id: string; canonical_name: string }[] }),
    projectStateIds.length
      ? supabaseServer.from("execute_project_states").select("id, memory_entities(canonical_name)").in("id", projectStateIds)
      : Promise.resolve({ data: [] as { id: string; memory_entities: unknown }[] }),
  ]);

  const names = new Map((people ?? []).map((person) => [person.id, person.canonical_name]));
  const projects = new Map(
    (projectStates ?? []).map((row) => {
      const memory = Array.isArray(row.memory_entities) ? row.memory_entities[0] : row.memory_entities;
      return [row.id, (memory as { canonical_name?: string } | null)?.canonical_name ?? "Untitled project"];
    })
  );

  return { items: new Map(rows.map((row) => [row.id, row])), names, projects };
}

function toItemSummary(
  row: ItemRow | undefined,
  names: Map<string, string>,
  projects: Map<string, string>
): ReviewEntry["item"] {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    responsibility: row.responsibility,
    timingAt: row.timing_at,
    timingKind: row.timing_kind,
    relatedPersonName: row.related_person_entity_id ? names.get(row.related_person_entity_id) ?? null : null,
    expectedAt: row.expected_at,
    waitingSince: row.waiting_since,
    obligationContext: row.obligation_context,
    projectName: row.project_state_id ? projects.get(row.project_state_id) ?? null : null,
  };
}

export async function loadReconciliationReview(): Promise<ReconciliationReviewData> {
  const [{ data: candidates, error: candidateError }, { data: attentionRows, error: attentionError }] = await Promise.all([
    supabaseServer
      .from("execution_items")
      .select("id, title, status, responsibility, timing_at, timing_kind, related_person_entity_id, expected_at, waiting_since, obligation_context, project_state_id, created_at")
      .eq("status", "candidate")
      .order("created_at", { ascending: true }),
    supabaseServer
      .from("execute_attention_items")
      .select("id, kind, execution_item_id, title, detail, payload, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  ]);
  if (candidateError) throw new Error(`Could not load candidates: ${candidateError.message}`);
  if (attentionError) throw new Error(`Could not load attention items: ${attentionError.message}`);

  const candidateRows = (candidates ?? []) as ItemRow[];
  const attention = attentionRows ?? [];

  const linkedItemIds = attention.map((row) => row.execution_item_id).filter((id): id is string => Boolean(id));
  const allItemIds = [...new Set([...candidateRows.map((row) => row.id), ...linkedItemIds])];
  const { items, names, projects } = await loadItemContext(allItemIds);

  const attentionIds = attention.map((row) => row.id);
  const { data: decisionRows } = attentionIds.length
    ? await supabaseServer
        .from("reconciliation_decisions")
        .select("id, evidence_ref, confidence, match_basis, reasoning_summary")
        .in("evidence_ref->>attentionItemId", attentionIds)
    : { data: [] as { id: string; evidence_ref: Record<string, unknown>; confidence: number | null; match_basis: string | null; reasoning_summary: string }[] };

  const decisionByAttentionId = new Map(
    (decisionRows ?? []).map((row) => [(row.evidence_ref as { attentionItemId?: string })?.attentionItemId ?? "", row])
  );

  const entries: ReviewEntry[] = [];

  for (const row of candidateRows) {
    entries.push({
      id: `candidate:${row.id}`,
      type: row.responsibility === "external" ? "external_candidate" : "dave_candidate",
      attentionItemId: null,
      executionItemId: row.id,
      title: row.title,
      detail: null,
      createdAt: row.created_at,
      item: toItemSummary(row, names, projects),
      proposedTitle: null,
      matchScore: null,
      matchBasis: null,
      evidenceExcerpt: null,
    });
  }

  for (const row of attention) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const decision = decisionByAttentionId.get(row.id);
    const linkedItem = row.execution_item_id ? items.get(row.execution_item_id) : undefined;

    const type: ReviewEntry["type"] =
      row.kind === "proposed_completion" ? "completion_proposal"
      : row.kind === "proposed_cancellation" ? "cancellation_proposal"
      : row.kind === "ambiguous_merge" ? "ambiguous_match"
      : row.kind === "waiting_overdue" ? "waiting_overdue"
      : "project_nomination";

    entries.push({
      id: `attention:${row.id}`,
      type,
      attentionItemId: row.id,
      executionItemId: row.execution_item_id,
      title: row.title,
      detail: row.detail,
      createdAt: row.created_at,
      item: toItemSummary(linkedItem, names, projects),
      proposedTitle: typeof payload.proposedTitle === "string" ? payload.proposedTitle : null,
      matchScore: typeof payload.score === "number" ? payload.score : decision?.confidence ?? null,
      matchBasis: decision?.match_basis ?? null,
      evidenceExcerpt: typeof payload.excerpt === "string" ? payload.excerpt : null,
    });
  }

  entries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return { entries };
}
