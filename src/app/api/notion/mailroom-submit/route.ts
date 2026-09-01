import { NextResponse } from "next/server";

import { NotionWebhookAuthError, requireNotionWebhookAuth } from "@/lib/auth/notionWebhookAuth";
import { completeTrace, emitDiagnosticEvent, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { reconcileNotionSubmission } from "@/lib/mailroom/reconcileNotionSubmission";
import { parseMailroomWebhookPayload } from "@/lib/notion/parseMailroomWebhookPayload";
import { supabaseServer } from "@/lib/supabase/server";
import { isRequestedAction } from "@/lib/mailroom/actionModel";
import { dispatchMailroomCommand, enqueueMailroomCommand } from "@/lib/mailroom/mailroomCommands";
import { resolveExecutionTarget } from "@/lib/mailroom/executionTarget";

/**
 * Notion Mailroom submission intake -- the target of the Notion database
 * button's "Send webhook" action.
 *
 * Notion cannot construct arbitrary JSON for a button webhook, so the
 * production request body is whatever envelope Notion's "Send webhook"
 * action actually sends (page metadata plus any selected properties, e.g.
 * "Outlook Message ID" -- see parseMailroomWebhookPayload for why that
 * shape is handled tolerantly). Only the Notion page id is taken from that
 * payload; every other reviewed value (Bucket, Requested Action, Human
 * Reply Edit, Human Instruction / Feedback, Submitted) is re-read live from
 * the Notion page via the API inside reconcileNotionSubmission, never
 * trusted from the webhook body.
 *
 * The legacy `{ notionPageId }` / `{ conversationId }` body shape is still
 * accepted, for local testing and Proxy-side retries without a Notion round
 * trip.
 *
 * Authenticated by a dedicated shared secret (NOTION_WEBHOOK_SECRET), not
 * PROXY_ADMIN_API_TOKEN: Notion cannot send an Authorization bearer header,
 * only a flat custom header, and this endpoint's trust boundary (a Notion
 * automation) is distinct from Proxy's own admin/internal callers.
 *
 * On successful reconciliation, dispatches the reviewed Requested Action
 * into the durable execution_commands pipeline (Power Automate), keyed on
 * the specific actionable outlookMessageId -- never the conversationId,
 * which is provenance/grouping only, not an Outlook mutation target.
 */
export async function POST(request: Request) {
  const traceId = await startTrace({
    module: "mailroom",
    sourceType: "notion",
    summary: "Notion Mailroom webhook received",
  });

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "notion_webhook",
    eventType: "webhook_received",
    status: "success",
    humanSummary: "Notion Mailroom submission webhook received.",
  });

  try {
    requireNotionWebhookAuth(request);
  } catch (error) {
    if (error instanceof NotionWebhookAuthError) {
      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "notion_webhook",
        eventType: "authentication_failed",
        status: "failure",
        severity: "warning",
        humanSummary: "Notion Mailroom webhook authentication failed.",
        // Deliberately no header value or comparison detail here -- never
        // put the secret (or evidence narrowing it down) in diagnostics.
        technicalDetail: error.message,
      });
      await completeTrace(traceId, { status: "failed", summary: "Webhook authentication failed" });
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_webhook",
      eventType: "page_id_resolved",
      status: "failure",
      severity: "warning",
      humanSummary: "Notion webhook body was not valid JSON.",
    });
    await completeTrace(traceId, { status: "failed", summary: "Invalid JSON body" });
    return NextResponse.json({ success: false, error: "A JSON body is required." }, { status: 400 });
  }

  const parsed = parseMailroomWebhookPayload(body);

  if (!parsed.notionPageId && !parsed.conversationId) {
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_webhook",
      eventType: "page_id_resolved",
      status: "failure",
      severity: "warning",
      humanSummary: "Could not resolve a Notion page id or conversation id from the webhook payload.",
      metadata: { observedShape: parsed.observedShape },
    });
    await completeTrace(traceId, { status: "failed", summary: "No notionPageId or conversationId in payload" });
    return NextResponse.json(
      { success: false, error: "Could not resolve notionPageId or conversationId from the request." },
      { status: 400 }
    );
  }

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "notion_webhook",
    eventType: "page_id_resolved",
    status: "success",
    humanSummary: parsed.notionPageId
      ? `Resolved Notion page id ${parsed.notionPageId} from webhook payload.`
      : `Resolved conversation id ${parsed.conversationId} from request body (legacy shape).`,
    metadata: { observedShape: parsed.observedShape },
  });

  try {
    const result = await reconcileNotionSubmission({
      notionPageId: parsed.notionPageId,
      conversationId: parsed.conversationId,
      traceId,
    });

    if (!result.ok || !result.mailroomConversationId) {
      await completeTrace(traceId, { status: "failed", summary: result.error ?? "Submission failed" });

      if (!result.pageId) {
        // The webhook never resolved to a concrete Notion page -- a
        // request/payload problem, not a downstream one, so this stays a
        // real 4xx.
        return NextResponse.json({ success: false, traceId, ...result }, { status: 400 });
      }

      // The Notion page WAS identified; everything from here on is
      // downstream reconciliation, not a request failure. Accept the
      // webhook (200) so Notion never shows "Button failed to execute" for
      // a submission it delivered correctly -- surface the failure via
      // Inspector General and the JSON body instead.
      await recordIssue({
        traceId,
        issueType: "mailroom_notion_reconciliation_failed",
        severity: "warning",
        humanSummary: result.error ?? "Notion Mailroom submission could not be reconciled.",
        objectType: "mailroom_conversation",
        objectId: result.conversationId,
        sourceType: "notion",
        sourceId: result.pageId,
        retryable: true,
      });
      return NextResponse.json({ success: false, traceId, ...result }, { status: 200 });
    }

    const commandResult = await enqueueReconciledCommand(result.mailroomConversationId, traceId);

    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_submission",
      eventType: "execution_command_result",
      status: commandResult.error ? "failure" : "success",
      severity: commandResult.error ? "warning" : "info",
      objectType: "mailroom_conversation",
      objectId: result.mailroomConversationId,
      humanSummary: commandResult.commandId
        ? `Execution command ${commandResult.reused ? "reused" : "created"} (status: ${commandResult.status ?? "unknown"}).`
        : commandResult.skipped
          ? `No execution command needed: ${commandResult.skipped}`
          : `Execution command could not be created: ${commandResult.error ?? "unknown reason"}`,
      metadata: {
        commandId: commandResult.commandId,
        reused: commandResult.reused,
        status: commandResult.status,
        skipped: commandResult.skipped,
      },
    });

    if (commandResult.error) {
      // Reconciliation succeeded; command creation is downstream from the
      // webhook's perspective, so this never turns into a non-200 -- just
      // recorded so it's visible and actionable in Inspector General.
      await recordIssue({
        traceId,
        issueType: "mailroom_notion_command_creation_failed",
        severity: "warning",
        humanSummary: `Notion submission reconciled, but the execution command could not be created: ${commandResult.error}`,
        objectType: "mailroom_conversation",
        objectId: result.mailroomConversationId,
        sourceType: "notion",
        sourceId: result.pageId,
        retryable: true,
      });
    }

    await completeTrace(traceId, {
      status: "completed",
      summary: `Submission reconciled (${result.changedFields.length} field(s) changed by Dave)${
        commandResult.commandId ? `; command ${commandResult.reused ? "reused" : "queued"}` : ""
      }`,
    });

    return NextResponse.json({ success: true, traceId, ...result, command: commandResult }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Notion Mailroom submission failed:", error);
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}

/**
 * Turns a successfully reconciled row into a durable Mailroom execution
 * command. Reads the FINAL post-reconciliation state back from Supabase
 * (rather than reusing anything from the webhook payload) so the command
 * reflects Dave's reviewed decision.
 *
 * The actionable outlookMessageId is resolved from the LIVE `emails` table,
 * never trusted blindly from mailroom_conversations.latest_message_id.
 * latest_message_id is analysis provenance -- it can go stale (the message
 * moved, the mailbox changed) between when a conversation was analyzed and
 * when Dave actually submits the review, and Power Automate's connector
 * needs a Graph message id that still exists in the store today or the
 * mutation 404s (ErrorItemNotFound). The live Inbox row with the newest
 * message_at/received_at is treated as the actionable message; every other
 * live Inbox row on the same conversation goes into priorInboxMessageIds so
 * it gets archived regardless of what disposition is chosen for the current
 * message.
 */
async function enqueueReconciledCommand(
  mailroomConversationId: string,
  traceId: string | null
): Promise<{ commandId: string | null; status: string | null; reused: boolean; error?: string; skipped?: string }> {
  const { data: conversation, error } = await supabaseServer
    .from("mailroom_conversations")
    .select("id, conversation_id, latest_message_id, is_meeting_invitation, requested_action, suggested_reply")
    .eq("id", mailroomConversationId)
    .maybeSingle();

  if (error || !conversation) {
    return { commandId: null, status: null, reused: false, error: error?.message ?? "Reconciled conversation not found" };
  }

  const action = conversation.requested_action;
  if (!isRequestedAction(action) || action === "none") {
    return { commandId: null, status: null, reused: false, skipped: "Requested Action is \"none\"; nothing to execute." };
  }

  const { data: threadRows, error: threadError } = await supabaseServer
    .from("emails")
    .select("outlook_message_id, internet_message_id, is_in_inbox, message_at, received_at, subject, from_email")
    .eq("conversation_id", conversation.conversation_id);

  if (threadError) {
    return {
      commandId: null,
      status: null,
      reused: false,
      error: `Could not load the live conversation thread: ${threadError.message}`,
    };
  }

  const rows = threadRows ?? [];
  const target = resolveExecutionTarget(rows, conversation.latest_message_id as string | null);

  if (!target) {
    /*
     * No live Inbox message remains for this conversation. For "archive"
     * that IS the desired end state -- something already archived it -- so
     * treat resubmission as idempotent completion rather than surfacing an
     * unexplained 404 from Power Automate. Every other action genuinely
     * needs a live Inbox message to act on.
     */
    if (action === "archive") {
      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "notion_submission",
        eventType: "execution_already_satisfied",
        status: "success",
        objectType: "mailroom_conversation",
        objectId: conversation.id as string,
        humanSummary: 'No live Inbox message remains for this conversation; treating "Archive" as already complete.',
      });
      return {
        commandId: null,
        status: null,
        reused: false,
        skipped: "No live Inbox message remains for this conversation; already archived.",
      };
    }

    await recordIssue({
      traceId,
      issueType: "mailroom_no_live_inbox_message",
      severity: "warning",
      humanSummary: `Requested action "${action}" could not be executed: no live Inbox message remains for this conversation.`,
      objectType: "mailroom_conversation",
      objectId: conversation.id as string,
      retryable: false,
    });
    return {
      commandId: null,
      status: null,
      reused: false,
      error: `No live Inbox message remains for conversation ${conversation.conversation_id}; cannot execute "${action}".`,
    };
  }

  const { outlookMessageId, internetMessageId, priorInboxMessageIds, stale } = target;
  // Subject/sender are display-only diagnostics -- looked up from the same
  // rows already fetched, never re-queried.
  const currentRow = rows.find((row) => row.outlook_message_id === outlookMessageId);

  if (stale) {
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_submission",
      eventType: "execution_target_refreshed",
      status: "success",
      severity: "warning",
      objectType: "mailroom_conversation",
      objectId: conversation.id as string,
      humanSummary:
        "Stale analysis target refreshed: mailroom_conversations.latest_message_id no longer matches the live Inbox message; using the current live message instead.",
      metadata: { staleMessageId: conversation.latest_message_id, liveMessageId: outlookMessageId },
    });
  }

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "notion_submission",
    eventType: "execution_target_resolved",
    status: "success",
    objectType: "mailroom_conversation",
    objectId: conversation.id as string,
    humanSummary: `Resolved current live Outlook message for "${currentRow?.subject ?? "(no subject)"}" from ${
      currentRow?.from_email ?? "unknown sender"
    }; ${priorInboxMessageIds.length} prior Inbox message(s) queued for cleanup.`,
    metadata: { outlookMessageId, internetMessageId, priorInboxMessageIds, requestedAction: action },
  });

  const enqueueResult = await enqueueMailroomCommand(
    {
      action,
      conversationId: conversation.id as string,
      outlookConversationId: conversation.conversation_id as string,
      outlookMessageId,
      internetMessageId,
      priorInboxMessageIds,
      suggestedReplyBody: conversation.suggested_reply ?? null,
    },
    conversation.is_meeting_invitation === true,
    "notion"
  );

  if (enqueueResult.commandId && !enqueueResult.reused) {
    await dispatchMailroomCommand(enqueueResult.commandId);
  }

  return enqueueResult;
}
