import { NextResponse } from "next/server";

import { NotionWebhookAuthError, requireNotionWebhookAuth } from "@/lib/auth/notionWebhookAuth";
import { completeTrace, emitDiagnosticEvent, startTrace } from "@/lib/diagnostics/emitEvent";
import { reconcileNotionSubmission } from "@/lib/mailroom/reconcileNotionSubmission";
import { parseMailroomWebhookPayload } from "@/lib/notion/parseMailroomWebhookPayload";
import { supabaseServer } from "@/lib/supabase/server";
import { isRequestedAction } from "@/lib/mailroom/actionModel";
import { dispatchMailroomCommand, enqueueMailroomCommand } from "@/lib/mailroom/mailroomCommands";

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
      return NextResponse.json({ success: false, traceId, ...result }, { status: 400 });
    }

    const commandResult = await enqueueReconciledCommand(result.mailroomConversationId);

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
 * reflects Dave's reviewed decision, keyed on the specific actionable
 * outlookMessageId -- conversationId is grouping/provenance only.
 * priorInboxMessageIds carries every other inbox message on the same
 * conversation, so they can be archived regardless of what disposition is
 * chosen for the current message.
 */
async function enqueueReconciledCommand(
  mailroomConversationId: string
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

  const { data: threadRows } = await supabaseServer
    .from("emails")
    .select("outlook_message_id, internet_message_id, is_in_inbox")
    .eq("conversation_id", conversation.conversation_id);

  const priorInboxMessageIds = (threadRows ?? [])
    .filter((row) => row.is_in_inbox === true && row.outlook_message_id !== conversation.latest_message_id)
    .map((row) => row.outlook_message_id as string);
  const internetMessageId =
    (threadRows ?? []).find((row) => row.outlook_message_id === conversation.latest_message_id)?.internet_message_id ?? null;

  const enqueueResult = await enqueueMailroomCommand(
    {
      action,
      conversationId: conversation.id as string,
      outlookConversationId: conversation.conversation_id as string,
      outlookMessageId: conversation.latest_message_id as string,
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
