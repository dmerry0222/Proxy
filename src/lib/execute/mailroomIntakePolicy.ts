/**
 * Pure, zero-import leaf module: how a Mailroom conversation becomes a
 * durable Execution Item.
 *
 * The conceptual split this enforces:
 *   Mailroom = intake and classification.
 *   Execute  = durable actionable work.
 *
 * Mailroom therefore never becomes a competing task list, and Execute never
 * has to re-derive "does this email matter?" -- it takes Mailroom's answer
 * and owns what happens next.
 *
 * Idempotency is structural, not heuristic. Every item created here is keyed
 * (source_system='mailroom', source_ref=conversation_id), which is a unique
 * index in Postgres. mailroom_conversations holds ONE ROW PER RUN per
 * conversation (1055 rows across 141 distinct Needs Attention conversations
 * today), so reprocessing must collapse to the newest row per conversation
 * before it decides anything -- that collapse is `latestPerConversation`.
 */

export type MailroomIntakeRow = {
  id: string;
  conversationId: string;
  /** The selected action, which defaults to Proxy's recommendation. */
  requestedAction: string | null;
  /** Proxy's classification-time recommendation, kept for provenance. */
  recommendedAction: string | null;
  /** default | proxy_ui | notion -- who last set requestedAction. */
  selectedActionSource: string;
  reviewState: string;
  category: string;
  summary: string | null;
  latestMessageId: string | null;
  receivedAt: string | null;
  createdAt: string;
  /** Subject of the conversation's latest message, joined from emails. */
  subject?: string | null;
  senderName?: string | null;
};

export type MailroomIntakePlan = {
  conversationId: string;
  title: string;
  description: string | null;
  status: "candidate" | "active";
  confirmedByUser: boolean;
  /** Provenance sentence stored on the item, readable without a join. */
  whySurfaced: string;
  outlookMessageId: string | null;
  occurredAt: string | null;
  metadata: Record<string, unknown>;
};

export const NEEDS_ATTENTION = "needs_attention";

/**
 * Collapses the per-run rows down to the newest row per conversation.
 * Without this, one conversation analyzed across 6 runs looks like 6
 * decisions, and the oldest one could win.
 */
export function latestPerConversation(rows: MailroomIntakeRow[]): MailroomIntakeRow[] {
  const newest = new Map<string, MailroomIntakeRow>();

  for (const row of rows) {
    const current = newest.get(row.conversationId);
    if (!current || new Date(row.createdAt).getTime() > new Date(current.createdAt).getTime()) {
      newest.set(row.conversationId, row);
    }
  }

  return [...newest.values()];
}

export function qualifiesForExecute(row: MailroomIntakeRow): boolean {
  return row.requestedAction === NEEDS_ATTENTION;
}

/**
 * A human -- in the Proxy review UI or in Notion -- deciding "this needs my
 * attention" is a materially stronger signal than classification defaulting
 * to it. It is the difference between an item Dave owns and a proposal he has
 * not looked at, so it drives both status and confirmed_by_user.
 */
export function isHumanConfirmed(row: MailroomIntakeRow): boolean {
  return row.selectedActionSource === "proxy_ui" || row.selectedActionSource === "notion" || row.reviewState === "submitted";
}

function firstSentence(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(" — "));
  return (boundary > max * 0.5 ? cut.slice(0, boundary) : cut).trim();
}

/**
 * The email's subject is the title Dave will recognize; the AI summary is the
 * body. Falling back the other way round (summary as title) produces a list
 * of paragraphs, which is unreadable at a glance.
 */
export function planIntake(row: MailroomIntakeRow): MailroomIntakePlan {
  const subject = row.subject?.trim();
  const summary = row.summary?.trim() || null;
  const confirmed = isHumanConfirmed(row);

  const title = subject
    ? firstSentence(subject, 300)
    : summary
      ? firstSentence(summary, 300)
      : `Needs attention: conversation ${row.conversationId.slice(0, 12)}`;

  const who = row.senderName?.trim();
  const decidedBy =
    row.selectedActionSource === "default"
      ? "Proxy classified it"
      : `You marked it in ${row.selectedActionSource === "notion" ? "Notion" : "the Proxy review"}`;

  return {
    conversationId: row.conversationId,
    title,
    description: summary,
    status: confirmed ? "active" : "candidate",
    confirmedByUser: confirmed,
    whySurfaced: `Mailroom: ${decidedBy} Needs Attention${who ? ` (from ${who})` : ""}.`,
    outlookMessageId: row.latestMessageId,
    occurredAt: row.receivedAt ?? row.createdAt,
    metadata: {
      source_type: "mailroom_conversation",
      conversation_id: row.conversationId,
      mailroom_category: row.category,
      recommended_action: row.recommendedAction,
      selected_action_source: row.selectedActionSource,
      review_state: row.reviewState,
      source_occurred_at: row.receivedAt ?? row.createdAt,
      /*
       * The classification sentence, kept where curation cannot overwrite
       * it. execution_items.why_surfaced belongs to curationPolicy.ts after
       * creation, so this is the durable record of why Mailroom sent this
       * item to Execute in the first place.
       */
      mailroom_reason: `Mailroom: ${decidedBy} Needs Attention${who ? ` (from ${who})` : ""}.`,
    },
  };
}

export type IntakeDiff = {
  /** Conversations that should have an item and currently do not. */
  toCreate: MailroomIntakePlan[];
  /** Conversations that still qualify and already have an item. */
  toRefresh: MailroomIntakePlan[];
  /**
   * Conversation ids with an existing item whose source no longer says
   * Needs Attention. These are NEVER deleted -- they get source_withdrawn_at
   * stamped, which curation reads and explains.
   */
  toWithdraw: string[];
  /** Previously withdrawn conversations that qualify again. */
  toReinstate: string[];
};

export function planIntakeBatch(
  rows: MailroomIntakeRow[],
  existing: Array<{ conversationId: string; withdrawn: boolean }>
): IntakeDiff {
  const latest = latestPerConversation(rows);
  const existingByConversation = new Map(existing.map((item) => [item.conversationId, item]));

  const toCreate: MailroomIntakePlan[] = [];
  const toRefresh: MailroomIntakePlan[] = [];
  const toReinstate: string[] = [];
  const qualifying = new Set<string>();

  for (const row of latest) {
    if (!qualifiesForExecute(row)) continue;
    qualifying.add(row.conversationId);

    const plan = planIntake(row);
    const already = existingByConversation.get(row.conversationId);

    if (!already) {
      toCreate.push(plan);
      continue;
    }

    toRefresh.push(plan);
    if (already.withdrawn) {
      toReinstate.push(row.conversationId);
    }
  }

  const toWithdraw = existing
    .filter((item) => !item.withdrawn && !qualifying.has(item.conversationId))
    .map((item) => item.conversationId);

  return { toCreate, toRefresh, toWithdraw, toReinstate };
}
