import { NextResponse } from "next/server";

import { requireAdminAuth } from "@/lib/auth/adminAuth";
import { supabaseServer } from "@/lib/supabase/server";
import { isRequestedAction } from "@/lib/mailroom/actionModel";
import { dispatchMailroomCommand, enqueueMailroomCommand } from "@/lib/mailroom/mailroomCommands";

/**
 * Intake for an action chosen outside the Proxy UI (i.e. in Notion).
 *
 * `execute` defaults to FALSE: editing the Requested Action select in
 * Notion only records a selection (correction pass Part 1 -- editing a
 * property is never a command). Power Automate sends `execute: true` only
 * when the human has pressed the explicit Process button, which is what
 * the polling flow actually watches for.
 */
export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
    const body = await request.json();
    const { conversationId, outlookMessageId, action, execute } = body;

    if (!isRequestedAction(action)) {
      return NextResponse.json({ success: false, error: "action must be one of the supported requested actions" }, { status: 400 });
    }
    if (!conversationId && !outlookMessageId) {
      return NextResponse.json({ success: false, error: "conversationId or outlookMessageId is required" }, { status: 400 });
    }

    let query = supabaseServer
      .from("mailroom_conversations")
      .select("id, conversation_id, latest_message_id, is_meeting_invitation, requested_action, recommended_action, suggested_reply")
      .order("created_at", { ascending: false })
      .limit(1);
    query = conversationId ? query.eq("id", conversationId) : query.eq("latest_message_id", outlookMessageId);
    const { data: conversation, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    if (!conversation) {
      return NextResponse.json({ success: false, error: "Mailroom conversation not found" }, { status: 404 });
    }

    // Validate before persisting, so an invalid selection (e.g. accept_invite
    // on ordinary mail) is rejected outright rather than silently stored.
    if (action === "accept_invite" && conversation.is_meeting_invitation !== true) {
      return NextResponse.json(
        { success: false, error: "accept_invite is only valid for a positively identified meeting invitation." },
        { status: 400 }
      );
    }

    const recommended = conversation.recommended_action;
    const { error: updateError } = await supabaseServer
      .from("mailroom_conversations")
      .update({ requested_action: action, selected_action_source: "notion" })
      .eq("id", conversation.id);
    if (updateError) throw new Error(updateError.message);

    if (recommended && recommended !== action) {
      await supabaseServer.from("mailroom_feedback").insert({
        mailroom_conversation_id: conversation.id,
        original_action: recommended,
        corrected_action: action,
      });
    }

    if (execute !== true) {
      return NextResponse.json({ success: true, result: { selected: action, executed: false } });
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

    if (enqueueResult.error) {
      return NextResponse.json({ success: false, error: enqueueResult.error }, { status: 400 });
    }
    if (enqueueResult.commandId && !enqueueResult.reused) {
      void dispatchMailroomCommand(enqueueResult.commandId);
    }

    return NextResponse.json({ success: true, result: { selected: action, executed: true, ...enqueueResult } });
  } catch (error) {
    console.error("Mailroom action intake failed:", error);
    const status = error instanceof Error && error.constructor.name === "AdminAuthError" ? 401 : 500;
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
