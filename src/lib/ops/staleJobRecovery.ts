import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { recordOrUpdateIssue, resolveIssueByDedupKey } from "@/lib/diagnostics/emitEvent";
import { dispatchMailroomCommand } from "@/lib/mailroom/mailroomCommands";
import { sweepPendingSourceSyncRuns } from "@/lib/memory/sourceSyncRuns";

/**
 * Priority 3: general stale-job recovery, not a one-off fix for the specific
 * rows found stuck on 2026-09-01/02. Two independent recovery policies,
 * called from the same pg_cron-driven maintenance tick as everything else in
 * this closeout so future stale records get swept periodically instead of
 * sitting in 'processing' indefinitely.
 */

const EXECUTION_COMMAND_STALE_MS = 20 * 60 * 1000; // 20 minutes
const SOURCE_SYNC_RUN_STALE_MS = 30 * 60 * 1000; // 30 minutes

export type StaleExecutionCommandDisposition =
  | "reconciled_succeeded"
  | "requeued"
  | "attention_required"
  | "non_retryable_failure_flagged";

export type StaleRecoverySummary = {
  executionCommands: { checked: number; dispositions: Record<StaleExecutionCommandDisposition, number> };
  sourceSyncRuns: { resetToPending: number };
};

/**
 * For a stale mailroom 'archive' command, the desired result is directly
 * observable: does the source email's is_in_inbox now read false? This is
 * the "reconcile actual external state where possible" step required before
 * ever redispatching -- never redispatch just because external_execution_id
 * is null, since the external action may have started (and even completed)
 * before Proxy recorded an id for it, or without ever getting one at all
 * (Power Automate's callback can be lost independently of whether the
 * Outlook action itself succeeded).
 */
async function reconcileArchiveCommand(objectId: string): Promise<"succeeded" | "still_pending" | "unknown"> {
  const { data: conversation } = await supabaseServer
    .from("mailroom_conversations")
    .select("latest_message_id")
    .eq("id", objectId)
    .maybeSingle();

  if (!conversation?.latest_message_id) return "unknown";

  const { data: email } = await supabaseServer
    .from("emails")
    .select("is_in_inbox")
    .eq("outlook_message_id", conversation.latest_message_id)
    .maybeSingle();

  if (!email) return "unknown";
  return email.is_in_inbox === false ? "succeeded" : "still_pending";
}

export async function recoverStaleExecutionCommands(): Promise<StaleRecoverySummary["executionCommands"]> {
  const cutoff = new Date(Date.now() - EXECUTION_COMMAND_STALE_MS).toISOString();

  const { data: stale, error } = await supabaseServer
    .from("execution_commands")
    .select("id, domain, object_type, object_id, status, attempt_count, external_execution_id, last_error, payload, trace_id, created_at")
    .in("status", ["processing", "retrying"])
    .lt("created_at", cutoff);

  if (error) throw new Error(`Could not load stale execution_commands: ${error.message}`);

  const dispositions: Record<StaleExecutionCommandDisposition, number> = {
    reconciled_succeeded: 0,
    requeued: 0,
    attention_required: 0,
    non_retryable_failure_flagged: 0,
  };

  for (const command of stale ?? []) {
    const dedupKey = `stale_execution_command:${command.id}`;
    const action = (command.payload as Record<string, unknown> | null)?.action as string | undefined;

    // Never redispatch solely because external_execution_id is null -- it
    // proves nothing about whether the external action ran. Only 'archive'
    // has an observable desired-result signal today; everything else with an
    // external side effect goes to human attention rather than a guess.
    if (command.domain === "mailroom" && action === "archive") {
      const outcome = await reconcileArchiveCommand(command.object_id);

      if (outcome === "succeeded") {
        await supabaseServer
          .from("execution_commands")
          .update({
            status: "succeeded",
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_error: `Reconciled: source email already out of inbox (stale command recovery, was stuck ${command.status} since ${command.created_at}).`,
          })
          .eq("id", command.id);
        await resolveIssueByDedupKey(dedupKey, "Reconciled succeeded: observed email is out of inbox.");
        dispositions.reconciled_succeeded += 1;
        continue;
      }

      if (outcome === "still_pending" && command.attempt_count <= 1) {
        // Desired result demonstrably absent, low attempt count, no ambiguous
        // partial effect for a plain archive -- safe to redispatch.
        await supabaseServer
          .from("execution_commands")
          .update({ status: "retrying", updated_at: new Date().toISOString() })
          .eq("id", command.id);
        await dispatchMailroomCommand(command.id);
        await resolveIssueByDedupKey(dedupKey, "Requeued and redispatched.");
        dispositions.requeued += 1;
        continue;
      }
    }

    // Irreconcilable: draft_reply/needs_attention/etc. with no observable
    // signal, or an archive we already tried once and still can't confirm.
    // Leave status as-is (truthfully "unknown"), surface for human review.
    await recordOrUpdateIssue(dedupKey, {
      issueType: "stale_execution_command",
      severity: "warning",
      humanSummary: `Mailroom command stuck at "${command.status}" since ${command.created_at} could not be reconciled against observable state.`,
      technicalDetail: `domain=${command.domain} object_type=${command.object_type} object_id=${command.object_id} action=${action ?? "unknown"} attempt_count=${command.attempt_count} external_execution_id=${command.external_execution_id ?? "null"}`,
      objectType: command.object_type,
      objectId: command.object_id,
      sourceType: "execution_command",
      sourceId: command.id,
      retryable: false,
      traceId: command.trace_id as string | null,
    });
    dispositions.attention_required += 1;
  }

  // The 2 already-failed archive-side commands: terminal by definition, but
  // flag with an explicit non-retryable issue so they're visible rather than
  // silently sitting at 'failed' forever.
  const { data: failedWithError } = await supabaseServer
    .from("execution_commands")
    .select("id, object_type, object_id, last_error, trace_id")
    .eq("status", "failed")
    .not("last_error", "is", null);

  for (const command of failedWithError ?? []) {
    await recordOrUpdateIssue(`stale_execution_command_failed:${command.id}`, {
      issueType: "mailroom_command_non_retryable",
      severity: "warning",
      humanSummary: `Mailroom command failed and is not auto-retryable: ${command.last_error}`,
      objectType: command.object_type,
      objectId: command.object_id,
      sourceType: "execution_command",
      sourceId: command.id,
      retryable: false,
      traceId: command.trace_id as string | null,
    });
    dispositions.non_retryable_failure_flagged += 1;
  }

  return { checked: (stale ?? []).length, dispositions };
}

export async function recoverStaleSourceSyncRuns(): Promise<StaleRecoverySummary["sourceSyncRuns"]> {
  const cutoff = new Date(Date.now() - SOURCE_SYNC_RUN_STALE_MS).toISOString();

  const { data: stale, error } = await supabaseServer
    .from("source_sync_runs")
    .select("id, source_type, memory_started_at, created_at")
    .eq("memory_status", "processing")
    .lt("memory_started_at", cutoff);

  if (error) throw new Error(`Could not load stale source_sync_runs: ${error.message}`);

  let resetToPending = 0;
  for (const run of stale ?? []) {
    // Internal, self-contained work (Teams/calendar/email Memory sync) --
    // safely retryable. Reset to 'pending' rather than re-invoking directly
    // here so the existing conditional-claim mechanism in
    // processSourceSyncRun (memory_status = 'pending' -> 'processing') is
    // the only code path that ever starts one, matching how it already
    // handles the Realtime-vs-sweep race.
    await supabaseServer
      .from("source_sync_runs")
      .update({
        memory_status: "pending",
        memory_error: `Reset from stale 'processing' (started ${run.memory_started_at ?? run.created_at}, lost its worker).`,
      })
      .eq("id", run.id);
    resetToPending += 1;
  }

  if (resetToPending > 0) {
    await sweepPendingSourceSyncRuns();
  }

  return { resetToPending };
}

export async function recoverStaleJobs(): Promise<StaleRecoverySummary> {
  const [executionCommands, sourceSyncRuns] = await Promise.all([
    recoverStaleExecutionCommands(),
    recoverStaleSourceSyncRuns(),
  ]);
  return { executionCommands, sourceSyncRuns };
}
