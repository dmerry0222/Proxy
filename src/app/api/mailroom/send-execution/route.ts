import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";
import { isRequestedAction, type RequestedAction } from "@/lib/mailroom/actionModel";
import { dispatchMailroomCommand, enqueueMailroomCommand } from "@/lib/mailroom/mailroomCommands";

/**
 * THE EXPLICIT EXECUTION BOUNDARY (correction pass Part 1).
 *
 * Selecting a Requested Action -- in the Proxy UI or in Notion -- only ever
 * records a selection. Nothing touches Outlook until this endpoint is
 * called for a specific run. That preserves the intended lifecycle:
 *
 *   Proxy recommends -> human may re-select -> nothing executes
 *   -> human explicitly presses Process -> durable commands created here
 *   -> Power Automate performs the Outlook mutation.
 *
 * Replaces the previous mechanism (a Resend email carrying a JSON payload
 * with a magic subject line), which had no durable per-action state,
 * no idempotency, and no failure/retry visibility.
 */
export async function POST(request: Request) {
  try {
    const { runId, conversationIds } = (await request.json()) as {
      runId?: string;
      conversationIds?: string[];
    };

    if (!runId) {
      return NextResponse.json({ success: false, error: "Missing runId" }, { status: 400 });
    }

    const { data: run, error: runError } = await supabaseServer
      .from("mailroom_runs")
      .select("id, status")
      .eq("id", runId)
      .maybeSingle();
    if (runError) throw new Error(`Could not load run: ${runError.message}`);
    if (!run) throw new Error("Mailroom run not found");

    let query = supabaseServer
      .from("mailroom_conversations")
      .select("id, conversation_id, latest_message_id, requested_action, is_meeting_invitation, suggested_reply")
      .eq("run_id", runId);
    if (Array.isArray(conversationIds) && conversationIds.length > 0) {
      query = query.in("id", conversationIds);
    }
    const { data: conversations, error: conversationError } = await query;
    if (conversationError) throw new Error(`Could not load conversations: ${conversationError.message}`);

    const rows = conversations ?? [];
    const messageIds = rows.map((row) => row.latest_message_id).filter((id): id is string => Boolean(id));

    // Conversation-scoped context, resolved by TRUE Outlook conversation
    // identity (never subject matching): the immutable Message-ID used for
    // command identity, plus the other Inbox messages in each thread that
    // cleanup should archive.
    const conversationKeys = [...new Set(rows.map((row) => row.conversation_id).filter(Boolean))];
    const { data: threadRows } = conversationKeys.length
      ? await supabaseServer
          .from("emails")
          .select("outlook_message_id, internet_message_id, conversation_id, is_in_inbox, folder")
          .in("conversation_id", conversationKeys)
      : { data: [] as { outlook_message_id: string; internet_message_id: string | null; conversation_id: string | null; is_in_inbox: boolean | null; folder: string | null }[] };

    const internetIdByMessageId = new Map(
      (threadRows ?? []).map((row) => [row.outlook_message_id, row.internet_message_id])
    );

    const results: Array<{ conversationId: string; action: RequestedAction; commandId: string | null; status: string | null; reused: boolean; error?: string }> = [];

    for (const row of rows) {
      const action = row.requested_action;
      if (!isRequestedAction(action) || action === "none") continue;
      if (!row.latest_message_id) continue;

      // Prior Inbox messages in the SAME Outlook conversation, excluding the
      // actionable message itself and anything not currently in Inbox (so
      // Sent Items and already-filed mail are never moved).
      const priorInboxMessageIds = (threadRows ?? [])
        .filter(
          (candidate) =>
            candidate.conversation_id === row.conversation_id &&
            candidate.is_in_inbox === true &&
            candidate.outlook_message_id !== row.latest_message_id
        )
        .map((candidate) => candidate.outlook_message_id);

      const enqueueResult = await enqueueMailroomCommand(
        {
          action,
          conversationId: row.id as string,
          outlookConversationId: row.conversation_id as string,
          outlookMessageId: row.latest_message_id as string,
          internetMessageId: internetIdByMessageId.get(row.latest_message_id) ?? null,
          priorInboxMessageIds,
          suggestedReplyBody: row.suggested_reply ?? null,
        },
        row.is_meeting_invitation === true,
        "proxy_ui"
      );

      results.push({
        conversationId: row.id as string,
        action,
        commandId: enqueueResult.commandId,
        status: enqueueResult.status,
        reused: enqueueResult.reused,
        ...(enqueueResult.error ? { error: enqueueResult.error } : {}),
      });

      if (enqueueResult.commandId && !enqueueResult.reused) {
        void dispatchMailroomCommand(enqueueResult.commandId);
      }
    }

    const { error: statusError } = await supabaseServer
      .from("mailroom_runs")
      .update({ status: "executing" })
      .eq("id", runId);
    if (statusError) throw new Error(`Could not mark run executing: ${statusError.message}`);

    return NextResponse.json({
      success: true,
      runId,
      messagesConsidered: messageIds.length,
      commandsCreated: results.filter((result) => result.commandId && !result.reused).length,
      commandsReused: results.filter((result) => result.reused).length,
      rejected: results.filter((result) => result.error).length,
      results,
    });
  } catch (error) {
    console.error("Mailroom execution failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown Mailroom execution error" },
      { status: 500 }
    );
  }
}
