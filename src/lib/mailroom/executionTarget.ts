/**
 * Pure, zero-import leaf module (same shape as actionModel.ts) for picking
 * the actionable Outlook message an execution command should target.
 *
 * mailroom_conversations.latest_message_id is analysis provenance, not a
 * live Outlook mutation target -- it can go stale between when a
 * conversation was analyzed and when a human actually submits the review
 * (the mailbox moves on). Blindly sending it to Power Automate produced a
 * real production failure: HTTP 404 ErrorItemNotFound, because the Graph
 * message id no longer existed in the store. The fix is to always resolve
 * the target from the LIVE thread instead: the Inbox row with the newest
 * message_at/received_at is the current actionable message, and every
 * other live Inbox row on the conversation is prior cleanup.
 */

export type ExecutionThreadRow = {
  outlook_message_id: string;
  internet_message_id: string | null;
  is_in_inbox: boolean | null;
  message_at: string | null;
  received_at: string | null;
};

export type ExecutionTarget = {
  outlookMessageId: string;
  internetMessageId: string | null;
  priorInboxMessageIds: string[];
  /** True when this differs from the caller-supplied stored/analysis message id. */
  stale: boolean;
};

function messageTimeOf(row: ExecutionThreadRow): number {
  const value = row.message_at ?? row.received_at;
  return value ? new Date(value).getTime() : 0;
}

/**
 * Returns null when there is no live Inbox message left on the
 * conversation at all -- the caller decides what that means (e.g.
 * "Archive" treats it as already-satisfied; other actions treat it as a
 * failure), since that judgment depends on the requested action, which this
 * module deliberately knows nothing about.
 */
export function resolveExecutionTarget(
  rows: ExecutionThreadRow[],
  storedMessageId: string | null
): ExecutionTarget | null {
  const inboxRows = rows.filter((row) => row.is_in_inbox === true);
  if (inboxRows.length === 0) {
    return null;
  }

  const currentRow = [...inboxRows].sort((a, b) => messageTimeOf(b) - messageTimeOf(a))[0];

  return {
    outlookMessageId: currentRow.outlook_message_id,
    internetMessageId: currentRow.internet_message_id,
    priorInboxMessageIds: inboxRows
      .filter((row) => row.outlook_message_id !== currentRow.outlook_message_id)
      .map((row) => row.outlook_message_id),
    stale: currentRow.outlook_message_id !== storedMessageId,
  };
}
