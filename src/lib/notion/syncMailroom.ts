import "server-only";

import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";
import { loadLatestMailroomRun, type MailroomReviewConversation } from "@/lib/mailroom/loadLatestMailroomRun";
import { ensureMailroomWorkspace } from "./ensureWorkspace";
import { getSurfaceMapping } from "./mapping";
import {
  dateProperty,
  emptyCounts,
  richTextProperty,
  selectProperty,
  syncOne,
  titleProperty,
  type ObjectSyncCounts,
  type SyncError,
} from "./pageSync";
import type { NotionWorkspaceDatabaseKey } from "./types";
import { ACTION_LABELS } from "@/lib/mailroom/actionModel";

export type MailroomWorkspaceStatus = {
  key: NotionWorkspaceDatabaseKey;
  status: "found" | "would_create";
  dataSourceId: string | null;
};

export type MailroomSyncSummary = {
  dryRun: boolean;
  limit: number | null;
  totalConversations: number;
  consideredConversations: number;
  workspace: MailroomWorkspaceStatus[];
  conversations: ObjectSyncCounts;
  errors: SyncError[];
};

async function resolveWorkspace(dryRun: boolean): Promise<{ status: MailroomWorkspaceStatus; dataSourceId: string | null }> {
  if (!dryRun) {
    const ds = await ensureMailroomWorkspace();
    return {
      status: { key: "mailroom_conversations", status: "found", dataSourceId: ds.conversationsDataSourceId },
      dataSourceId: ds.conversationsDataSourceId,
    };
  }

  const mapping = await getSurfaceMapping("notion_workspace_database", "mailroom_conversations");
  return {
    status: {
      key: "mailroom_conversations",
      status: mapping?.externalObjectId ? "found" : "would_create",
      dataSourceId: mapping?.externalObjectId ?? null,
    },
    dataSourceId: mapping?.externalObjectId ?? null,
  };
}

function senderText(conversation: MailroomReviewConversation): string {
  if (conversation.senderName && conversation.senderEmail) {
    return `${conversation.senderName} <${conversation.senderEmail}>`;
  }
  return conversation.senderName ?? conversation.senderEmail ?? "";
}

/**
 * Projects the current live Mailroom review state (loadLatestMailroomRun --
 * the same merge of live Outlook Inbox state + latest analysis the bespoke
 * Mailroom UI already uses) into the Notion Mailroom database. One Notion
 * page per Outlook conversation, keyed by conversationId.
 *
 * Read-only projection only: this does not create the "Submit to Proxy"
 * automation (that's a manually-configured Notion automation watching
 * "Review Status", per Brief Part 2) and there is no inbound webhook yet
 * (Brief Part 4) -- a human editing Review Status / Human Reply Edit /
 * Human Instruction in Notion today has no effect on Proxy. Those fields
 * are seeded once on page creation and never touched again by this sync
 * (see buildCreateOnlyProperties below), so they're safe to write to by
 * hand without this sync clobbering them on the next run.
 *
 * `limit` bounds how many conversations are actually pushed in apply mode
 * (dry run always evaluates the full live set, since it never calls
 * Notion) -- useful for validating a handful of real pages before a full
 * backfill of the whole Inbox.
 */
export async function syncMailroomToNotion(options: {
  dryRun: boolean;
  traceId: string | null;
  limit?: number | null;
}): Promise<MailroomSyncSummary> {
  const { dryRun, traceId, limit = null } = options;

  const workspace = await resolveWorkspace(dryRun);
  await emitDiagnosticEvent({
    traceId,
    module: "notion",
    stage: "sync_mailroom",
    eventType: "workspace_resolved",
    status: "success",
    humanSummary: dryRun ? "Checked Mailroom workspace database (dry run)" : "Ensured Mailroom workspace database",
    metadata: { status: workspace.status },
  });

  const { conversations: allConversations } = await loadLatestMailroomRun();
  const conversations = dryRun || limit === null ? allConversations : allConversations.slice(0, limit);

  const counts = emptyCounts();
  const errors: SyncError[] = [];

  for (const conversation of conversations) {
    const canonicalFields = {
      subject: conversation.subject,
      sender: senderText(conversation),
      bucket: conversation.bucket,
      summary: conversation.summary,
      requestedAction: ACTION_LABELS[conversation.requestedAction],
      receivedAt: conversation.latestMessageAt,
      suggestedReply: conversation.suggestedReply,
      outlookMessageId: conversation.latestMessageId,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "mailroom_conversation",
      objectId: conversation.conversationId,
      dataSourceId: workspace.dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Conversation: titleProperty(canonicalFields.subject || "(no subject)"),
        Sender: richTextProperty(canonicalFields.sender),
        Bucket: selectProperty(canonicalFields.bucket),
        Summary: richTextProperty(canonicalFields.summary),
        "Requested Action": conversation.requestedAction === "none" ? selectProperty(null) : selectProperty(canonicalFields.requestedAction),
        "Date Received": dateProperty(canonicalFields.receivedAt),
        "Suggested Reply": richTextProperty(canonicalFields.suggestedReply),
        "Conversation ID": richTextProperty(conversation.conversationId),
        "Outlook Message ID": richTextProperty(canonicalFields.outlookMessageId),
      }),
      buildCreateOnlyProperties: () => ({
        "Review Status": selectProperty("Reviewing"),
        "Human Reply Edit": richTextProperty(null),
        "Human Instruction / Feedback": richTextProperty(null),
        // Left empty on creation and never rewritten by sync -- only the
        // Notion button (human) sets it to "Requested", and only Power
        // Automate clears it. A re-sync must never re-arm an execution.
        "Execution Status": selectProperty(null),
      }),
    });

    counts[action] += 1;
    if (action === "error") {
      errors.push({ objectType: "mailroom_conversation", objectId: conversation.conversationId, message: "See diagnostics." });
    }
  }

  return {
    dryRun,
    limit,
    totalConversations: allConversations.length,
    consideredConversations: conversations.length,
    workspace: [workspace.status],
    conversations: counts,
    errors,
  };
}
