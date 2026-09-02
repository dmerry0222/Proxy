import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { pullExecuteFromNotion } from "@/lib/notion/pullExecute";

/**
 * Notion -> Execute: reads back the fields Notion owns (manual planning
 * dates, project filing, milestones, and the plateau/prep notes attached to a
 * meeting) and makes them durable in Supabase.
 *
 * The mirror of /api/notion/sync-execute, and admin-gated the same way. Pass
 * `{"dryRun": true}` to see what would be adopted without writing anything --
 * useful the first time, when the answer to "what has Dave changed in Notion?"
 * is genuinely unknown.
 */
export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  const url = new URL(request.url);
  let dryRun = url.searchParams.get("dryRun") === "true";

  if (!dryRun && request.headers.get("content-length") !== "0") {
    try {
      const body = await request.json();
      if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
    } catch {
      // No body, or not JSON -- dryRun stays as resolved from the query string.
    }
  }

  const traceId = await startTrace({
    module: "notion",
    sourceType: "execute",
    summary: dryRun ? "Notion → Execute pull (dry run)" : "Notion → Execute pull",
  });

  try {
    const summary = await pullExecuteFromNotion({ dryRun, traceId });

    await completeTrace(traceId, {
      status: summary.errors.length ? "failed" : "completed",
      summary: `Notion → Execute pull completed with ${summary.errors.length} error(s)`,
    });

    return NextResponse.json({ success: true, traceId, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Notion pull error";
    console.error("Notion → Execute pull failed:", error);

    await completeTrace(traceId, { status: "failed", summary: message });
    await recordIssue({
      traceId,
      issueType: "notion_pull_run_failed",
      severity: "critical",
      humanSummary: "Notion → Execute pull run failed",
      retryable: true,
      technicalDetail: message,
    });

    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
