import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, emitDiagnosticEvent, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { reopenStaleMailroomConversations } from "@/lib/mailroom/staleAnalysisRepair";
import { runMailroomAnalysis } from "@/lib/mailroom/analyzeMailroom";
import { syncMailroomToNotion } from "@/lib/notion/syncMailroom";

/**
 * One-time/deliberate backlog catch-up -- for bringing a multi-day Mailroom
 * analysis gap current in one call instead of waiting on the maintenance
 * cron's per-invocation cap.
 *
 * Reuses runMailroomAnalysis() exactly as the cron and the manual "Analyze
 * Next Batch" button do -- same model, same 50-conversation-per-call
 * behavior, same rate limits. No special/cheaper analysis mode: this route
 * just calls that same function repeatedly (up to MAX_ITERATIONS, a safety
 * cap against ever looping unboundedly) until the backlog is exhausted,
 * then runs the normal Notion projection once at the end.
 *
 * Protected identically to /api/mailroom/maintenance (Authorization:
 * Bearer <PROXY_ADMIN_API_TOKEN>). Meant to be triggered once by hand, not
 * scheduled.
 */
const MAX_ITERATIONS = 10;

export async function POST(request: Request) {
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
    sourceType: "admin_backfill",
    summary: "Mailroom analysis backlog catch-up",
  });

  let reopened: { reopenedMessages: number; conversationIds: string[] } | null = null;
  try {
    reopened = await reopenStaleMailroomConversations();
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "backfill",
      eventType: "stale_conversations_reopened",
      status: "success",
      humanSummary: `Reopened ${reopened.conversationIds.length} stale conversation(s) for reanalysis before backfilling.`,
      metadata: reopened,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await recordIssue({
      traceId,
      issueType: "mailroom_stale_reopen_failed",
      severity: "error",
      humanSummary: "Could not reopen stale Mailroom conversations before backfill.",
      retryable: true,
      technicalDetail: message,
    });
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }

  const iterations: Array<{ runId: string | null; conversationsAnalyzed: number }> = [];
  let totalAnalyzed = 0;

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result = await runMailroomAnalysis();
      iterations.push(result);
      totalAnalyzed += result.conversationsAnalyzed;

      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "backfill",
        eventType: "analysis_batch_completed",
        status: "success",
        humanSummary: `Backfill batch ${i + 1}: analyzed ${result.conversationsAnalyzed} conversation(s).`,
        metadata: { batch: i + 1, runId: result.runId, conversationsAnalyzed: result.conversationsAnalyzed },
      });

      if (result.conversationsAnalyzed === 0) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Mailroom analysis error";
    await recordIssue({
      traceId,
      issueType: "mailroom_analysis_failed",
      severity: "error",
      humanSummary: "Mailroom analysis failed during backfill.",
      retryable: true,
      technicalDetail: message,
    });
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json(
      { success: false, traceId, reopened, iterations, totalAnalyzed, error: message },
      { status: 500 }
    );
  }

  let syncSummary: Awaited<ReturnType<typeof syncMailroomToNotion>> | null = null;
  let syncError: string | null = null;
  try {
    syncSummary = await syncMailroomToNotion({ dryRun: false, traceId, limit: null });
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "backfill",
      eventType: "notion_projection_completed",
      status: syncSummary.errors.length > 0 ? "failure" : "success",
      humanSummary: `Backfill Notion projection: ${syncSummary.conversations.created} created, ${syncSummary.conversations.updated} updated, ${syncSummary.errors.length} failed. ${syncSummary.backlogNotEligible} conversation(s) still not eligible.`,
      metadata: { counts: syncSummary.conversations, backlogNotEligible: syncSummary.backlogNotEligible },
    });
  } catch (error) {
    syncError = error instanceof Error ? error.message : "Unknown Notion sync error";
    await recordIssue({
      traceId,
      issueType: "mailroom_notion_projection_failed",
      severity: "error",
      humanSummary: "Notion projection failed at the end of backfill.",
      retryable: true,
      technicalDetail: syncError,
    });
  }

  const hitIterationCap = iterations.length === MAX_ITERATIONS && iterations[iterations.length - 1]?.conversationsAnalyzed > 0;

  await completeTrace(traceId, {
    status: syncError ? "failed" : "completed",
    summary: `Backfill: ${reopened.conversationIds.length} reopened, ${totalAnalyzed} analyzed across ${iterations.length} batch(es)${
      hitIterationCap ? " (iteration cap reached -- backlog may not be fully clear, re-run)" : ""
    }, Notion backlog remaining: ${syncSummary?.backlogNotEligible ?? "unknown"}.`,
  });

  return NextResponse.json({
    success: !syncError,
    traceId,
    reopened,
    iterations,
    totalAnalyzed,
    hitIterationCap,
    notionSync: syncSummary ?? { error: syncError },
  });
}
