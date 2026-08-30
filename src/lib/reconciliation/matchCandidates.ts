import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { titleSimilarity } from "./titleSimilarity";
import type { ActorRef } from "./types";

/*
 * Deterministic candidate retrieval and ranking (Brief Part 7). Steps 1-2
 * (narrowing, retrieval) shipped in Phase 1. Step 3 (semantic
 * reconciliation across the small candidate set) ships here in Phase 3 as
 * deterministic title-similarity scoring, reusing the same token-overlap
 * function claimReconciliation.ts already uses for claim merging --
 * genuinely source-agnostic string-similarity logic, not claim-specific.
 *
 * A bounded-LLM disambiguation step (matching claimReconciliation.ts's
 * rule-pass-then-model-fallback pattern) is deliberately NOT built yet.
 * Building that prompt now, before any real reconciliation data exists to
 * test it against, means guessing at a shape that would likely need
 * rework once real emails are processed. RANK_ATTACH_THRESHOLD and
 * RANK_REVIEW_THRESHOLD below are initial, deliberately conservative
 * values -- expect to tune both after seeing real reconciliation runs
 * (Brief Part 26).
 */

/** Score at or above this: treat as the same underlying obligation (attach evidence, don't create a new item). */
export const RANK_ATTACH_THRESHOLD = 0.6;
/** Score at or above this but below RANK_ATTACH_THRESHOLD: plausible but uncertain -- route to review rather than silently merging or silently duplicating. */
export const RANK_REVIEW_THRESHOLD = 0.35;

export type CandidateExecutionItem = {
  id: string;
  title: string;
  status: string;
  responsibility: string;
  assigneeEntityId: string | null;
  requesterEntityId: string | null;
  relatedPersonEntityId: string | null;
  projectStateId: string | null;
  timingAt: string | null;
  obligationContext: string | null;
  createdAt: string;
};

type ExecutionItemRow = {
  id: string;
  title: string;
  status: string;
  responsibility: string;
  assignee_entity_id: string | null;
  requester_entity_id: string | null;
  related_person_entity_id: string | null;
  project_state_id: string | null;
  timing_at: string | null;
  obligation_context: string | null;
  created_at: string;
};

function toCandidate(row: ExecutionItemRow): CandidateExecutionItem {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    responsibility: row.responsibility,
    assigneeEntityId: row.assignee_entity_id,
    requesterEntityId: row.requester_entity_id,
    relatedPersonEntityId: row.related_person_entity_id,
    projectStateId: row.project_state_id,
    timingAt: row.timing_at,
    obligationContext: row.obligation_context,
    createdAt: row.created_at,
  };
}

/**
 * Narrows to open execution items (candidate/active/deferred -- completed
 * and cancelled work is never a merge target) that share at least one
 * known actor with the evidence being reconciled, or belong to the same
 * Execute project when no actor overlap is available. Returns at most
 * `limit` items, most recent first, for a caller to run further
 * (semantic) disambiguation over.
 */
export async function findCandidateExecutionItems(
  input: { actors: ActorRef[]; projectStateId?: string | null },
  limit = 10
): Promise<CandidateExecutionItem[]> {
  const entityIds = input.actors.map((actor) => actor.entityId).filter((id): id is string => Boolean(id));

  if (entityIds.length === 0 && !input.projectStateId) {
    return [];
  }

  let query = supabaseServer
    .from("execution_items")
    .select(
      "id, title, status, responsibility, assignee_entity_id, requester_entity_id, related_person_entity_id, project_state_id, timing_at, obligation_context, created_at"
    )
    .in("status", ["candidate", "active", "deferred"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (entityIds.length > 0) {
    const idList = entityIds.join(",");
    query = query.or(
      `assignee_entity_id.in.(${idList}),requester_entity_id.in.(${idList}),related_person_entity_id.in.(${idList})`
    );
  } else if (input.projectStateId) {
    query = query.eq("project_state_id", input.projectStateId);
  }

  const { data, error } = await query.returns<ExecutionItemRow[]>();

  if (error) {
    throw new Error(`Could not load candidate execution items: ${error.message}`);
  }

  return (data ?? []).map(toCandidate);
}

export type RankedCandidate = { item: CandidateExecutionItem; score: number };

/**
 * Scores each candidate's title against `titleHint` and returns them best
 * match first. Pure/local -- no AI call, no I/O. A false duplicate merge
 * can be worse than two separate candidates (Brief Part 7), so this is
 * intentionally a narrow token-overlap score, not a fuzzy/embedding match:
 * callers should treat RANK_REVIEW_THRESHOLD..RANK_ATTACH_THRESHOLD as
 * "uncertain, needs a human," not "close enough."
 */
export function rankCandidatesByTitle(titleHint: string, candidates: CandidateExecutionItem[]): RankedCandidate[] {
  return candidates
    .map((item) => ({ item, score: titleSimilarity(titleHint, item.title) }))
    .sort((a, b) => b.score - a.score);
}

/** Narrows a candidate set to only those matching a given responsibility ("mine" or "external") before ranking. */
export function filterByResponsibility(
  candidates: CandidateExecutionItem[],
  responsibility: "mine" | "external"
): CandidateExecutionItem[] {
  return candidates.filter((candidate) => candidate.responsibility === responsibility);
}

export type OpenItemContext = {
  id: string;
  title: string;
  responsibility: string;
  counterpartName: string | null;
  timingAt: string | null;
  status: string;
};

/**
 * Phase 4.5 Finding B: a small, bounded summary of currently-open items
 * plausibly related to a Teams conversation, so a later delta lacking the
 * original commitment ("Wednesday instead" / "still coming Friday?") has
 * enough operational continuity to be interpreted -- without replaying the
 * conversation's history. NOT a trusted decision surface: this only
 * supplies context strings for the extraction prompt. Any item the model
 * references is still just a candidate reference (see teamsEvidence.ts),
 * and the actual attach/create/review decision is still made by
 * reconcileEnvelope's own matching, unaffected by this function.
 *
 * "Plausibly related" = open items either evidenced from this exact chat
 * before, or sharing an actor with the current batch's known participants.
 * Deliberately excludes any project-only signal (Brief Part 12 project
 * association is out of scope through Phase 5) and caps at `limit` items
 * so this never becomes "unrelated Execute inventory."
 */
export async function findOpenItemsContext(
  input: { chatId: string; actorEntityIds: string[] },
  limit = 5
): Promise<OpenItemContext[]> {
  const chatLinkedIds = new Set<string>();
  const { data: evidenceRows, error: evidenceError } = await supabaseServer
    .from("execution_evidence")
    .select("execution_item_id, source_locator")
    .eq("source_type", "teams_message")
    .order("created_at", { ascending: false })
    .limit(50);

  if (evidenceError) {
    throw new Error(`Could not load Teams evidence for context: ${evidenceError.message}`);
  }

  for (const row of evidenceRows ?? []) {
    const locator = row.source_locator as { chat_id?: string } | null;
    if (locator?.chat_id === input.chatId) {
      chatLinkedIds.add(row.execution_item_id as string);
    }
  }

  const actorCandidates =
    input.actorEntityIds.length > 0
      ? await findCandidateExecutionItems({ actors: input.actorEntityIds.map((entityId) => ({ entityId, email: null, name: null })) }, limit)
      : [];

  const idsToFetch = new Set<string>([...chatLinkedIds, ...actorCandidates.map((c) => c.id)]);
  if (idsToFetch.size === 0) {
    return [];
  }

  const { data: itemRows, error: itemError } = await supabaseServer
    .from("execution_items")
    .select("id, title, status, responsibility, timing_at, requester_entity_id, related_person_entity_id, created_at")
    .in("id", [...idsToFetch])
    .in("status", ["candidate", "active", "deferred"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (itemError) {
    throw new Error(`Could not load open items for context: ${itemError.message}`);
  }

  const rows = itemRows ?? [];
  const counterpartIds = rows
    .map((row) => row.requester_entity_id ?? row.related_person_entity_id)
    .filter((id): id is string => Boolean(id));

  const nameByEntityId = new Map<string, string>();
  if (counterpartIds.length > 0) {
    const { data: entityRows, error: entityError } = await supabaseServer
      .from("memory_entities")
      .select("id, canonical_name")
      .in("id", counterpartIds);
    if (entityError) {
      throw new Error(`Could not load entity names for context: ${entityError.message}`);
    }
    for (const row of entityRows ?? []) {
      nameByEntityId.set(row.id as string, row.canonical_name as string);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    responsibility: row.responsibility,
    counterpartName: nameByEntityId.get(row.requester_entity_id ?? row.related_person_entity_id ?? "") ?? null,
    timingAt: row.timing_at,
    status: row.status,
  }));
}

/**
 * Phase 5 Calendar: a calendar event may already be CONFIRMED linked to an
 * open execution item -- Calendar previously (or the item's originating
 * source) recorded execution_evidence citing this exact event_id. Unlike
 * every other matching path in this file, this is an identity lookup, not
 * a semantic guess: reschedule/cancellation handling for an already-linked
 * item doesn't need to re-derive ownership or re-run title scoring, it
 * just needs to know whether this specific event has a known counterpart.
 * Returns null (not a guess) when no such link exists or the linked item
 * is already terminal (completed/cancelled -- nothing to reschedule).
 */
export async function findConfirmedCalendarLink(eventId: string): Promise<CandidateExecutionItem | null> {
  const { data: evidenceRows, error: evidenceError } = await supabaseServer
    .from("execution_evidence")
    .select("execution_item_id")
    .eq("source_type", "calendar_event")
    .eq("source_locator->>calendar_event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (evidenceError) {
    throw new Error(`Could not check confirmed calendar link: ${evidenceError.message}`);
  }

  const executionItemId = evidenceRows?.[0]?.execution_item_id as string | undefined;
  if (!executionItemId) return null;

  const { data: itemRow, error: itemError } = await supabaseServer
    .from("execution_items")
    .select(
      "id, title, status, responsibility, assignee_entity_id, requester_entity_id, related_person_entity_id, project_state_id, timing_at, obligation_context, created_at"
    )
    .eq("id", executionItemId)
    .in("status", ["candidate", "active", "deferred"])
    .maybeSingle();

  if (itemError) {
    throw new Error(`Could not load confirmed calendar link's item: ${itemError.message}`);
  }

  return itemRow ? toCandidate(itemRow as ExecutionItemRow) : null;
}
