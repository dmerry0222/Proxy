import "server-only";

import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";
import { loadLatestMailroomRun, type MailroomReviewConversation } from "@/lib/mailroom/loadLatestMailroomRun";
import { ensureMailroomWorkspace } from "./ensureWorkspace";
import { getSurfaceMapping } from "./mapping";
import {
  checkboxProperty,
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
import { migrateMailroomSchema, type MailroomSchemaMigrationReport } from "./migrateMailroomSchema";

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
  /**
   * Result of bringing the live Notion schema into compliance before any
   * page is written. Reported rather than silently performed: a page push
   * that names a property Notion doesn't have fails the whole page, so a
   * failed migration is the most likely explanation for a failed sync.
   */
  schemaMigration: MailroomSchemaMigrationReport | null;
  conversations: ObjectSyncCounts;
  errors: SyncError[];
};

/**
 * Properties Proxy proposes but Dave may override in Notion during review.
 * Exported so the submission path releases exactly the same set it guards.
 */
export const MAILROOM_GUARDED_PROPERTIES = ["Bucket", "Requested Action"];

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

/*
 * Outlook stores a missing display name as an EMPTY STRING, not null --
 * every message in this mailbox has from_name = "". The previous
 * `senderName ?? senderEmail` fell through to "" (?? only catches
 * null/undefined), so the email address was discarded and Sender rendered
 * blank on every Notion page. Treat blank as absent.
 */
function senderText(conversation: MailroomReviewConversation): string {
  const name = conversation.senderName?.trim() || null;
  const email = conversation.senderEmail?.trim() || null;

  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? "";
}

/**
 * Projects the current live Mailroom review state (loadLatestMailroomRun --
 * the same merge of live Outlook Inbox state + latest analysis the bespoke
 * Mailroom UI already uses) into the Notion Mailroom database. One Notion
 * page per Outlook conversation, keyed by conversationId.
 *
 * Outbound projection: this does not create the per-row Submit button
 * (a manual Notion setup step) and the button->Proxy webhook is not wired
 * yet. Human Reply Edit / Human Instruction / Submitted / Execution Status
 * are seeded once on page creation and never touched again by this sync
 * (see buildCreateOnlyProperties below), so they're safe to write to by
 * hand without this sync clobbering them on the next run.
 *
 * Bucket and Requested Action are guarded rather than human-owned: Proxy
 * keeps proposing them, but a human edit to either is preserved until it
 * is submitted (see MAILROOM_GUARDED_PROPERTIES).
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

  /*
   * Bring the live schema into compliance BEFORE pushing pages. The
   * best-effort patch inside ensureMailroomWorkspace swallows its errors so
   * it can never block a sync; this call is the one that reads the schema
   * back and reports what actually happened. Ordering matters: every page
   * write below names "Requested Action" / "Date Received" / "Submitted",
   * and Notion rejects a page write that references a property the data
   * source doesn't have -- so a skipped migration would fail all 62 pages,
   * not degrade gracefully.
   */
  const schemaMigration = await migrateMailroomSchema({ dryRun, traceId });

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
      /*
       * Bucket and Requested Action are Proxy proposals that Dave edits
       * during review. Guarding them means a sweep landing between his edit
       * and his Submit press preserves the edit instead of reverting it.
       * Submission clears the guard (see reconcileNotionSubmission), so
       * Proxy resumes ownership once the value is canonical.
       */
      guardedProperties: MAILROOM_GUARDED_PROPERTIES,
      buildCreateOnlyProperties: () => ({
        "Human Reply Edit": richTextProperty(null),
        "Human Instruction / Feedback": richTextProperty(null),
        // Left empty on creation and never rewritten by sync -- only the
        // Notion button (human) sets it to "Requested", and only Power
        // Automate clears it. A re-sync must never re-arm an execution.
        "Execution Status": selectProperty(null),
        // Human-owned review signal. Seeded false once; never written by
        // sync again, so a resync cannot un-submit a reviewed row.
        Submitted: checkboxProperty(false),
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
    schemaMigration,
    conversations: counts,
    errors,
  };
}
