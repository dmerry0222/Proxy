import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { recordExecutionEvidence } from "@/lib/reconciliation/evidence";
import {
  completeReconciliationRun,
  recordReconciliationDecision,
  startReconciliationRun,
} from "@/lib/reconciliation/runs";
import {
  planIntakeBatch,
  type MailroomIntakePlan,
  type MailroomIntakeRow,
} from "@/lib/execute/mailroomIntakePolicy";

/**
 * Mailroom -> Execute. Turns "Needs Attention" classification into durable
 * Execution Items, idempotently.
 *
 * Deliberate properties:
 *  - ONE item per conversation, forever, enforced by a unique index on
 *    (source_system, source_ref) rather than by fuzzy title matching. Running
 *    this a hundred times produces the same 141 items.
 *  - Never destructive. When a conversation stops qualifying, the item is
 *    stamped source_withdrawn_at and drops out of the curated view with a
 *    stated reason; it is not deleted, and if Dave has already taken it up
 *    (status active / confirmed) it keeps its place.
 *  - Never overwrites Dave. Refresh updates the mail-derived fields
 *    (title/summary/provenance) and may promote candidate -> active when a
 *    human confirms the classification, but never demotes, never re-opens
 *    completed work, and never touches project, planning date, or effort.
 *
 * This does NOT route through reconcileEnvelope.ts, and that is on purpose:
 * that path exists to weigh AI-extracted ownership evidence and merge it
 * into possibly-matching items by title similarity. "Needs Attention" is not
 * evidence to be weighed -- it is a classification decision that already
 * happened, with a stable identity attached, and running it through fuzzy
 * matching would be the one thing the brief forbids: duplicate or
 * mis-merged items on every reprocess.
 */

const SOURCE_SYSTEM = "mailroom";
const PAGE_SIZE = 1000;
const MESSAGE_ID_CHUNK = 20;

export type MailroomIntakeSummary = {
  conversationsConsidered: number;
  created: number;
  refreshed: number;
  withdrawn: number;
  reinstated: number;
  errors: string[];
};

type ExistingItemRow = {
  id: string;
  source_ref: string;
  status: string;
  confirmed_by_user: boolean;
  source_withdrawn_at: string | null;
};

/**
 * Loads every Mailroom conversation row, not just the qualifying ones.
 * Withdrawal is computed by ABSENCE from the qualifying set, so a partial
 * read would look exactly like "these conversations stopped needing
 * attention" and would withdraw live work.
 */
async function loadAllConversations(): Promise<MailroomIntakeRow[]> {
  const rows: MailroomIntakeRow[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("mailroom_conversations")
      .select(
        "id, conversation_id, requested_action, recommended_action, selected_action_source, review_state, category, summary, latest_message_id, received_at, created_at"
      )
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Could not load Mailroom conversations: ${error.message}`);
    }

    for (const row of data ?? []) {
      rows.push({
        id: row.id,
        conversationId: row.conversation_id,
        requestedAction: row.requested_action,
        recommendedAction: row.recommended_action,
        selectedActionSource: row.selected_action_source,
        reviewState: row.review_state,
        category: row.category,
        summary: row.summary,
        latestMessageId: row.latest_message_id,
        receivedAt: row.received_at,
        createdAt: row.created_at,
      });
    }

    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

/** Subject/sender live on the email, not on the conversation row. */
async function attachMessageDetail(rows: MailroomIntakeRow[]): Promise<void> {
  const messageIds = [...new Set(rows.map((row) => row.latestMessageId).filter((id): id is string => Boolean(id)))];
  const detail = new Map<string, { subject: string | null; fromName: string | null; receivedAt: string | null }>();

  /*
   * Small chunks on purpose. Outlook message ids are ~150 characters each and
   * PostgREST puts `in.(...)` in the query string, so batching 200 of them
   * built a ~30KB URL and came back as a flat "Bad Request".
   */
  for (let index = 0; index < messageIds.length; index += MESSAGE_ID_CHUNK) {
    const chunk = messageIds.slice(index, index + MESSAGE_ID_CHUNK);
    const { data, error } = await supabaseServer
      .from("emails")
      .select("outlook_message_id, subject, from_name, received_at")
      .in("outlook_message_id", chunk);

    if (error) {
      throw new Error(`Could not load Mailroom message detail: ${error.message}`);
    }

    for (const email of data ?? []) {
      detail.set(email.outlook_message_id, {
        subject: email.subject,
        fromName: email.from_name,
        receivedAt: email.received_at,
      });
    }
  }

  for (const row of rows) {
    const match = row.latestMessageId ? detail.get(row.latestMessageId) : undefined;
    row.subject = match?.subject ?? null;
    row.senderName = match?.fromName ?? null;
    row.receivedAt = row.receivedAt ?? match?.receivedAt ?? null;
  }
}

async function recordMailProvenance(executionItemId: string, plan: MailroomIntakePlan): Promise<void> {
  if (!plan.outlookMessageId) return;

  await recordExecutionEvidence({
    executionItemId,
    sourceType: "email",
    sourceLocator: { outlook_message_id: plan.outlookMessageId },
    relationship: "supports_creation",
    excerpt: plan.description ?? plan.title,
    occurredAt: plan.occurredAt,
    metadata: { conversation_id: plan.conversationId, via: "mailroom_needs_attention" },
  });
}

export async function ingestMailroomNeedsAttention(): Promise<MailroomIntakeSummary> {
  const summary: MailroomIntakeSummary = {
    conversationsConsidered: 0,
    created: 0,
    refreshed: 0,
    withdrawn: 0,
    reinstated: 0,
    errors: [],
  };

  const conversations = await loadAllConversations();
  await attachMessageDetail(conversations);

  const { data: existingRows, error: existingError } = await supabaseServer
    .from("execution_items")
    .select("id, source_ref, status, confirmed_by_user, source_withdrawn_at")
    .eq("source_system", SOURCE_SYSTEM)
    .not("source_ref", "is", null);

  if (existingError) {
    throw new Error(`Could not load existing Mailroom-sourced items: ${existingError.message}`);
  }

  const existing = (existingRows ?? []) as ExistingItemRow[];
  const byConversation = new Map(existing.map((row) => [row.source_ref, row]));

  const diff = planIntakeBatch(
    conversations,
    existing.map((row) => ({ conversationId: row.source_ref, withdrawn: Boolean(row.source_withdrawn_at) }))
  );

  summary.conversationsConsidered = diff.toCreate.length + diff.toRefresh.length;

  if (!diff.toCreate.length && !diff.toRefresh.length && !diff.toWithdraw.length && !diff.toReinstate.length) {
    return summary;
  }

  const { runId, traceId } = await startReconciliationRun({
    trigger: "forward",
    sourceType: "mailroom_execute_intake",
    sourceId: "mailroom",
    summary: "Mailroom Needs Attention -> Execute",
    metadata: {
      candidates: diff.toCreate.length,
      refreshes: diff.toRefresh.length,
      withdrawals: diff.toWithdraw.length,
    },
  });

  const counters = {
    evidenceConsidered: summary.conversationsConsidered,
    itemsCreated: 0,
    itemsMatched: 0,
    itemsIgnored: 0,
    errors: 0,
  };

  for (const plan of diff.toCreate) {
    try {
      const { data, error } = await supabaseServer
        .from("execution_items")
        .insert({
          title: plan.title,
          description: plan.description,
          status: plan.status,
          responsibility: "mine",
          confirmed_by_user: plan.confirmedByUser,
          extraction_basis: "mailroom_needs_attention",
          source_system: SOURCE_SYSTEM,
          source_ref: plan.conversationId,
          why_surfaced: plan.whySurfaced,
          metadata: plan.metadata,
        })
        .select("id")
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? "Unknown insert error");
      }

      await recordMailProvenance(data.id as string, plan);
      await recordReconciliationDecision(traceId, {
        runId,
        evidenceRef: { conversationId: plan.conversationId, outlookMessageId: plan.outlookMessageId },
        outcome: "create_dave_item",
        matchedExecutionItemId: data.id as string,
        ownershipBasis: "explicit_user_intent",
        automatic: !plan.confirmedByUser,
        reasoningSummary: plan.whySurfaced,
      });

      summary.created += 1;
      counters.itemsCreated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      summary.errors.push(`create ${plan.conversationId}: ${message}`);
      counters.errors += 1;
    }
  }

  for (const plan of diff.toRefresh) {
    const current = byConversation.get(plan.conversationId);
    if (!current) continue;

    try {
      /*
       * Mail-derived fields only. Status is promoted candidate -> active
       * exactly when a human has now confirmed the classification; it is
       * never demoted, and completed/cancelled items are left alone entirely
       * so a re-run cannot resurrect finished work.
       *
       * why_surfaced is NOT refreshed here. Intake seeds it once at creation
       * so a new item is never wordless, and curationPolicy.ts owns it from
       * then on. Writing it on every refresh made the two writers fight:
       * intake set the provenance sentence, curation immediately replaced it
       * with the current reason, and 121 items changed on every single sweep
       * -- which then defeated the Notion canonical-hash skip and re-pushed
       * all of them. The original sentence survives in metadata.
       */
      const patch: Record<string, unknown> = {
        title: plan.title,
        description: plan.description,
        metadata: plan.metadata,
        updated_at: new Date().toISOString(),
      };

      const promotable = current.status === "candidate" && plan.confirmedByUser;
      if (promotable) {
        patch.status = "active";
        patch.confirmed_by_user = true;
      }

      if (current.status === "completed" || current.status === "cancelled") {
        delete patch.title;
        delete patch.description;
      }

      const { error } = await supabaseServer.from("execution_items").update(patch).eq("id", current.id);
      if (error) throw new Error(error.message);

      await recordMailProvenance(current.id, plan);
      summary.refreshed += 1;
      counters.itemsMatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      summary.errors.push(`refresh ${plan.conversationId}: ${message}`);
      counters.errors += 1;
    }
  }

  if (diff.toWithdraw.length) {
    const ids = diff.toWithdraw
      .map((conversationId) => byConversation.get(conversationId)?.id)
      .filter((id): id is string => Boolean(id));

    const { error } = await supabaseServer
      .from("execution_items")
      .update({ source_withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .in("id", ids);

    if (error) {
      summary.errors.push(`withdraw: ${error.message}`);
      counters.errors += 1;
    } else {
      summary.withdrawn = ids.length;
      counters.itemsIgnored += ids.length;
    }
  }

  if (diff.toReinstate.length) {
    const ids = diff.toReinstate
      .map((conversationId) => byConversation.get(conversationId)?.id)
      .filter((id): id is string => Boolean(id));

    const { error } = await supabaseServer
      .from("execution_items")
      .update({ source_withdrawn_at: null, updated_at: new Date().toISOString() })
      .in("id", ids);

    if (error) {
      summary.errors.push(`reinstate: ${error.message}`);
      counters.errors += 1;
    } else {
      summary.reinstated = ids.length;
    }
  }

  await completeReconciliationRun(runId, traceId, {
    status: summary.errors.length ? "failed" : "completed",
    counters,
    summary: `Mailroom -> Execute: ${summary.created} created, ${summary.refreshed} refreshed, ${summary.withdrawn} withdrawn, ${summary.reinstated} reinstated, ${summary.errors.length} error(s).`,
  });

  return summary;
}
