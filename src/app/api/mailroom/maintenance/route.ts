import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import {
  completeTrace,
  emitDiagnosticEvent,
  recordIssue,
  recordOrUpdateIssue,
  resolveIssueByDedupKey,
  startTrace,
} from "@/lib/diagnostics/emitEvent";
import { reopenStaleMailroomConversations } from "@/lib/mailroom/staleAnalysisRepair";
import { runMailroomAnalysis } from "@/lib/mailroom/analyzeMailroom";
import { syncMailroomToNotion } from "@/lib/notion/syncMailroom";
import { supabaseServer } from "@/lib/supabase/server";
import { processReceivedCaptures } from "@/lib/capture/processCapture";

const MAILROOM_ANALYSIS_GAP_KEY = "mailroom_analysis_gap";

/**
 * Priority 1 IG health requirement: email ingestion staying current while
 * Mailroom analysis silently stops (exactly what happened 2026-09-01) must
 * surface as an open issue, and a later successful run must auto-resolve it.
 * Checked after every maintenance cycle regardless of that cycle's own
 * outcome, since the interesting case is "ingestion fine, analysis broken",
 * not just "this one call failed".
 */
async function checkMailroomAnalysisGap(traceId: string | null): Promise<void> {
  const [{ data: newestEmail }, { data: lastSuccess }] = await Promise.all([
    supabaseServer
      .from("emails")
      .select("received_at")
      .eq("is_in_inbox", true)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseServer
      .from("diagnostic_traces")
      .select("started_at")
      .eq("module", "mailroom")
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!newestEmail?.received_at) return;

  const ingestionCurrentMs = Date.now() - new Date(newestEmail.received_at).getTime();
  const ingestionCurrent = ingestionCurrentMs < 2 * 60 * 60 * 1000; // 2 hours
  if (!ingestionCurrent) return;

  const gapMs = lastSuccess?.started_at
    ? Date.now() - new Date(lastSuccess.started_at).getTime()
    : Number.POSITIVE_INFINITY;
  const operatingIntervalMs = 30 * 60 * 1000; // 6x the 5-minute cron cadence

  if (gapMs > operatingIntervalMs) {
    await recordOrUpdateIssue(MAILROOM_ANALYSIS_GAP_KEY, {
      issueType: "mailroom_analysis_gap",
      severity: "error",
      humanSummary: "Email ingestion is current, but no successful Mailroom analysis run has completed within the expected operating interval.",
      technicalDetail: lastSuccess?.started_at
        ? `Last successful mailroom trace started at ${lastSuccess.started_at}.`
        : "No successful mailroom trace found at all.",
      sourceType: "cron",
      retryable: true,
      traceId,
    });
  } else {
    await resolveIssueByDedupKey(MAILROOM_ANALYSIS_GAP_KEY, "A subsequent Mailroom maintenance cycle completed successfully.");
  }
}

/**
 * The reliable, Vercel-cron-compatible replacement for "press Analyze Next
 * Batch, then press Sync Mailroom to Notion" -- the two steps that used to
 * require a human (or the in-process setInterval scheduler, which cannot be
 * trusted to stay alive on Vercel's serverless runtime) to run in sequence.
 * One complete Mailroom maintenance cycle:
 *
 *   1. Reopen conversations whose stored analysis has gone stale (a newer
 *      thread message arrived) so step 2's UNMODIFIED selection query picks
 *      them back up -- see staleAnalysisRepair.ts for why this is needed
 *      even though runMailroomAnalysis() itself already only considers
 *      unprocessed Inbox mail.
 *   2. runMailroomAnalysis() -- reused verbatim, same model/rate limits as
 *      the manual "Analyze Next Batch" button.
 *   3. syncMailroomToNotion() -- reused verbatim; only conversations with a
 *      CURRENT analysis are ever projected as reviewable Notion rows (see
 *      analysisReadiness.ts / syncMailroom.ts).
 *
 * Idempotent by construction: step 1 is a no-op once nothing is stale, step
 * 2 already no-ops on an empty backlog (runMailroomAnalysis returns
 * `{ runId: null, conversationsAnalyzed: 0 }` without creating a run), and
 * step 3's canonical-hash skip means an unchanged conversation is a no-op
 * Notion call. Safe to invoke as often as the schedule fires, including
 * concurrently with a manual "Analyze Next Batch" / "Sync Mailroom" click.
 *
 * Protected the same way every other admin-triggered Proxy route is:
 * `Authorization: Bearer <PROXY_ADMIN_API_TOKEN>` (see adminAuth.ts).
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * a `CRON_SECRET` env var is configured on the project -- set that env var
 * to the SAME value as PROXY_ADMIN_API_TOKEN so Vercel's own cron
 * invocation authenticates without any new auth code. See vercel.json for
 * the schedule.
 */
export async function GET(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  const traceId = await startTrace({
    module: "mailroom",
    sourceType: "cron",
    summary: "Mailroom maintenance cycle (reopen stale -> analyze -> project to Notion)",
  });

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "maintenance_cycle",
    eventType: "maintenance_started",
    status: "success",
    humanSummary: "Mailroom maintenance cycle started.",
  });

  let reopened: { reopenedMessages: number; conversationIds: string[] } | null = null;
  try {
    reopened = await reopenStaleMailroomConversations();
    if (reopened.conversationIds.length > 0) {
      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "maintenance_cycle",
        eventType: "stale_conversations_reopened",
        status: "success",
        humanSummary: `Reopened ${reopened.conversationIds.length} conversation(s) whose stored analysis had gone stale, so they will be reanalyzed.`,
        metadata: { conversationIds: reopened.conversationIds, reopenedMessages: reopened.reopenedMessages },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordIssue({
      traceId,
      issueType: "mailroom_stale_reopen_failed",
      severity: "error",
      humanSummary: "Could not reopen stale Mailroom conversations for reanalysis.",
      retryable: true,
      technicalDetail: message,
    });
  }

  let analysisResult: { runId: string | null; conversationsAnalyzed: number } | null = null;
  let analysisError: string | null = null;

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "maintenance_cycle",
    eventType: "analysis_started",
    status: "success",
    humanSummary: "Analyzing pending Mailroom conversations.",
  });

  try {
    analysisResult = await runMailroomAnalysis();
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "maintenance_cycle",
      eventType: "analysis_completed",
      status: "success",
      humanSummary:
        analysisResult.conversationsAnalyzed > 0
          ? `Analyzed ${analysisResult.conversationsAnalyzed} conversation(s) (run ${analysisResult.runId}).`
          : "No pending conversations required analysis.",
      metadata: { runId: analysisResult.runId, conversationsAnalyzed: analysisResult.conversationsAnalyzed },
    });
  } catch (error) {
    analysisError = error instanceof Error ? error.message : "Unknown Mailroom analysis error";
    await recordIssue({
      traceId,
      issueType: "mailroom_analysis_failed",
      severity: "error",
      humanSummary: "Mailroom analysis step of the maintenance cycle failed.",
      retryable: true,
      technicalDetail: analysisError,
    });
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "maintenance_cycle",
      eventType: "analysis_failed",
      status: "failure",
      severity: "error",
      humanSummary: "Mailroom analysis step failed; still projecting whatever is currently eligible to Notion.",
      technicalDetail: analysisError,
    });
  }

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "maintenance_cycle",
    eventType: "notion_projection_started",
    status: "success",
    humanSummary: "Projecting conversations with a current Mailroom analysis to Notion.",
  });

  let syncSummary: Awaited<ReturnType<typeof syncMailroomToNotion>> | null = null;
  let syncError: string | null = null;
  try {
    syncSummary = await syncMailroomToNotion({ dryRun: false, traceId, limit: null });
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "maintenance_cycle",
      eventType: "notion_projection_completed",
      status: syncSummary.errors.length > 0 ? "failure" : "success",
      severity: syncSummary.errors.length > 0 ? "warning" : "info",
      humanSummary: `Notion projection: ${syncSummary.conversations.created} created, ${syncSummary.conversations.updated} updated, ${syncSummary.conversations.skipped} unchanged, ${syncSummary.errors.length} failed. ${syncSummary.backlogNotEligible} conversation(s) remain without a current analysis.`,
      metadata: {
        counts: syncSummary.conversations,
        backlogNotEligible: syncSummary.backlogNotEligible,
        errors: syncSummary.errors,
      },
    });
  } catch (error) {
    syncError = error instanceof Error ? error.message : "Unknown Notion sync error";
    await recordIssue({
      traceId,
      issueType: "mailroom_notion_projection_failed",
      severity: "error",
      humanSummary: "Notion projection step of the maintenance cycle failed.",
      retryable: true,
      technicalDetail: syncError,
    });
  }

  let captureSummary: Awaited<ReturnType<typeof processReceivedCaptures>> | null = null;
  try {
    captureSummary = await processReceivedCaptures(25);
    if (captureSummary.claimed > 0) {
      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "maintenance_cycle",
        eventType: "captures_processed",
        status: captureSummary.failed > 0 ? "warning" : "success",
        humanSummary: `Processed ${captureSummary.claimed} capture(s): ${captureSummary.processed} completed, ${captureSummary.ignored} ignored as misfires, ${captureSummary.failed} failed.`,
        metadata: captureSummary,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown capture batch error";
    await recordIssue({
      traceId,
      issueType: "capture_batch_failed",
      severity: "error",
      humanSummary: "Capture processing batch failed.",
      retryable: true,
      technicalDetail: message,
    });
  }

  await checkMailroomAnalysisGap(traceId);

  const failed = Boolean(analysisError || syncError || (syncSummary && syncSummary.errors.length > 0));
  await completeTrace(traceId, {
    status: failed ? "failed" : "completed",
    summary: `Maintenance cycle: ${reopened?.conversationIds.length ?? 0} reopened, ${
      analysisResult?.conversationsAnalyzed ?? 0
    } analyzed, Notion ${
      syncSummary ? `${syncSummary.conversations.created} created / ${syncSummary.conversations.updated} updated` : "not synced"
    }, backlog ${syncSummary?.backlogNotEligible ?? "unknown"}, captures ${
      captureSummary ? `${captureSummary.processed} processed / ${captureSummary.ignored} ignored / ${captureSummary.failed} failed` : "not run"
    }.`,
  });

  return NextResponse.json(
    {
      success: !failed,
      traceId,
      reopened: reopened ?? { reopenedMessages: 0, conversationIds: [] },
      analysis: analysisResult ?? { runId: null, conversationsAnalyzed: 0, error: analysisError },
      notionSync: syncSummary ?? { error: syncError },
      captures: captureSummary ?? { claimed: 0, processed: 0, ignored: 0, failed: 0 },
    },
    { status: analysisError && syncError ? 500 : 200 }
  );
}
