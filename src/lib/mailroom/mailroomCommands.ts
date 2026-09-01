import "server-only";

import { createHash } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { startTrace, completeTrace, emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import { isActionValidForItem, mailroomCommandIdentity, type RequestedAction } from "@/lib/mailroom/actionModel";

/**
 * Durable action-command layer (Build Part 9-12). Reuses execution_commands
 * -- an existing table designed for exactly this "human decision -> durable
 * command -> Power Automate mutation -> result recorded back" flow, never
 * used by any code until now. No new queue table.
 *
 * Idempotency key is stable per (conversation, action): retrying the same
 * requested action always resolves to the same command row rather than
 * creating a new one. If that command already succeeded, a repeat request
 * is treated as already-done, not re-executed -- the safe default for
 * Outlook-mutating actions (Part 11).
 */

export type MailroomCommandPayload = {
  action: RequestedAction;
  conversationId: string; // mailroom_conversations.id
  outlookConversationId: string;
  outlookMessageId: string;
  /**
   * RFC 5322 Message-ID of the actionable message. Immutable: unlike
   * outlookMessageId (a Graph/EWS id that CHANGES when a message is moved
   * between folders, e.g. Inbox -> Archive), this survives the very moves
   * these actions perform. Used for command identity; outlookMessageId is
   * still what Power Automate acts on.
   */
  internetMessageId: string | null;
  priorInboxMessageIds: string[];
  suggestedReplyBody: string | null;
};

export type EnqueueSource = "proxy_ui" | "notion" | "migration_default";

/**
 * Command identity is (actionable message, action) -- NOT (conversation,
 * action). A conversation legitimately receives new messages over time, and
 * the same action on a newer message is a new, real command:
 *
 *   Mon: conversation X / message A / draft_reply -> succeeds
 *   Thu: conversation X / message B / draft_reply -> must create a NEW draft
 *
 * Keyed on internetMessageId when available (immutable across the folder
 * moves these actions perform) and falling back to the Graph id otherwise,
 * so retrying the same action on the same message stays idempotent.
 */
function idempotencyKey(payload: MailroomCommandPayload): string {
  return createHash("sha256").update(mailroomCommandIdentity(payload)).digest("hex");
}

export async function enqueueMailroomCommand(
  payload: MailroomCommandPayload,
  isMeetingInvitation: boolean,
  source: EnqueueSource
): Promise<{ commandId: string | null; status: string | null; reused: boolean; error?: string }> {
  const validation = isActionValidForItem(payload.action, isMeetingInvitation);
  if (!validation.valid) {
    return { commandId: null, status: null, reused: false, error: validation.reason };
  }
  // "none" is a valid recommendation/selection but never produces an
  // Outlook mutation -- nothing to enqueue.
  if (payload.action === "none") {
    return { commandId: null, status: null, reused: false };
  }

  const key = idempotencyKey(payload);

  const { data: existing, error: existingError } = await supabaseServer
    .from("execution_commands")
    .select("id, status")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (existingError) return { commandId: null, status: null, reused: false, error: existingError.message };

  if (existing) {
    return { commandId: existing.id as string, status: existing.status as string, reused: true };
  }

  const traceId = await startTrace({
    module: "mailroom_action",
    sourceType: "mailroom_conversation",
    sourceId: payload.conversationId,
    objectType: "mailroom_conversation",
    objectId: payload.conversationId,
    summary: `Requested action "${payload.action}" (source: ${source})`,
    metadata: { source },
  });

  const { data, error } = await supabaseServer
    .from("execution_commands")
    .insert({
      domain: "mailroom",
      object_type: "mailroom_conversation",
      object_id: payload.conversationId,
      payload: { ...payload, source },
      status: "queued",
      idempotency_key: key,
      trace_id: traceId,
    })
    .select("id, status")
    .single();
  if (error || !data) return { commandId: null, status: null, reused: false, error: error?.message ?? "Unknown error" };

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom_action",
    stage: "queued",
    eventType: "command_queued",
    status: "success",
    objectType: "mailroom_conversation",
    objectId: payload.conversationId,
    humanSummary: `Queued "${payload.action}" for dispatch to Power Automate.`,
  });

  return { commandId: data.id as string, status: data.status as string, reused: false };
}

/**
 * Fire-and-forget dispatch to Power Automate. Never throws -- a missing
 * POWER_AUTOMATE_MAILROOM_URL or a network failure leaves the command
 * `queued`/`retrying`, visible and safe to dispatch again later, never
 * silently marked successful (Part 11: "never mark an action successful
 * merely because an HTTP request was sent").
 */
export async function dispatchMailroomCommand(commandId: string): Promise<void> {
  const { data: command, error } = await supabaseServer
    .from("execution_commands")
    .select("id, payload, status, attempt_count, trace_id")
    .eq("id", commandId)
    .maybeSingle();
  if (error || !command) {
    console.error("Could not load mailroom command to dispatch:", commandId, error?.message);
    return;
  }
  if (command.status === "succeeded") return;

  const url = process.env.POWER_AUTOMATE_MAILROOM_URL;
  const now = new Date().toISOString();

  if (!url) {
    console.log(`Mailroom command ${commandId} queued; POWER_AUTOMATE_MAILROOM_URL not configured yet, leaving queued.`);
    await emitDiagnosticEvent({
      traceId: command.trace_id as string | null,
      module: "mailroom_action",
      stage: "dispatched",
      eventType: "command_left_queued",
      status: "success",
      objectType: "mailroom_conversation",
      humanSummary: "Left queued: POWER_AUTOMATE_MAILROOM_URL is not configured yet.",
    });
    return;
  }

  await supabaseServer
    .from("execution_commands")
    .update({ status: "processing", attempt_count: command.attempt_count + 1, started_at: command.attempt_count === 0 ? now : undefined, updated_at: now })
    .eq("id", commandId);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.POWER_AUTOMATE_MAILROOM_SECRET ? { "X-Proxy-Secret": process.env.POWER_AUTOMATE_MAILROOM_SECRET } : {}),
      },
      body: JSON.stringify({
        commandId: command.id,
        callbackUrl: `${process.env.PROXY_PUBLIC_BASE_URL ?? ""}/api/mailroom/commands/callback`,
        ...(command.payload as Record<string, unknown>),
      }),
    });
    if (!response.ok) {
      throw new Error(`Power Automate dispatch returned HTTP ${response.status}`);
    }
    await emitDiagnosticEvent({
      traceId: command.trace_id as string | null,
      module: "mailroom_action",
      stage: "dispatched",
      eventType: "command_dispatched",
      status: "success",
      objectType: "mailroom_conversation",
      humanSummary: "Dispatched to Power Automate.",
    });
  } catch (dispatchError) {
    const message = dispatchError instanceof Error ? dispatchError.message : "Unknown error";
    await supabaseServer.from("execution_commands").update({ status: "retrying", last_error: message, updated_at: new Date().toISOString() }).eq("id", commandId);
    await recordIssue({
      traceId: command.trace_id as string | null,
      issueType: "mailroom_dispatch_failed",
      severity: "error",
      humanSummary: "Could not dispatch Mailroom action to Power Automate.",
      objectType: "mailroom_conversation",
      retryable: true,
      technicalDetail: message,
    });
  }
}

export type CommandCallbackResult = {
  commandId: string;
  success: boolean;
  error?: string;
  draftId?: string;
  eventId?: string;
  outlookMessageId?: string;
  /** Graph's Message.webLink for the created draft (Part 13) -- a real, stable Outlook-on-the-web deep link, when Power Automate captures it from the createReplyAll/send response. */
  webLink?: string;
};

/** Power Automate reports back here (Part 10) -- Proxy is the only writer of command state. */
export async function recordMailroomCommandResult(result: CommandCallbackResult): Promise<{ ok: boolean; error?: string }> {
  const { data: command, error } = await supabaseServer
    .from("execution_commands")
    .select("id, trace_id, payload")
    .eq("id", result.commandId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!command) return { ok: false, error: "Command not found" };

  const now = new Date().toISOString();
  await supabaseServer
    .from("execution_commands")
    .update({
      status: result.success ? "succeeded" : "failed",
      completed_at: now,
      updated_at: now,
      last_error: result.error ?? null,
      external_execution_id: result.draftId ?? result.eventId ?? null,
      payload: result.webLink ? { ...(command.payload as Record<string, unknown>), webLink: result.webLink } : command.payload,
    })
    .eq("id", result.commandId);

  await completeTrace(command.trace_id as string | null, {
    status: result.success ? "completed" : "failed",
    summary: result.success ? "Power Automate reported success." : `Power Automate reported failure: ${result.error ?? "unknown"}`,
  });
  await emitDiagnosticEvent({
    traceId: command.trace_id as string | null,
    module: "mailroom_action",
    stage: "result",
    eventType: result.success ? "command_succeeded" : "command_failed",
    status: result.success ? "success" : "failure",
    objectType: "mailroom_conversation",
    humanSummary: result.success ? "Outlook action completed." : `Outlook action failed: ${result.error ?? "unknown"}`,
    metadata: { draftId: result.draftId, eventId: result.eventId },
  });
  if (!result.success) {
    await recordIssue({
      traceId: command.trace_id as string | null,
      issueType: "mailroom_action_failed",
      severity: "error",
      humanSummary: "Power Automate could not complete the requested Mailroom action.",
      objectType: "mailroom_conversation",
      retryable: true,
      technicalDetail: result.error ?? "Unknown error",
    });
  }

  return { ok: true };
}
