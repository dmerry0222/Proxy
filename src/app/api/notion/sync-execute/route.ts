import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { syncExecuteToNotion } from "@/lib/notion/syncExecute";

/**
 * Manually triggered Execute -> Notion projection (Brief Part 1/3).
 *
 * Not wired to a cron, webhook, or page load -- this is deliberately an
 * admin-only, explicitly-invoked endpoint while the Notion surface itself
 * is still being validated. Requires `Authorization: Bearer
 * <PROXY_ADMIN_API_TOKEN>`; see src/lib/auth/adminAuth.ts.
 *
 * Pass `{"dryRun": true}` (or `?dryRun=true`) to plan without touching
 * Notion or Supabase -- see syncExecuteToNotion for exactly what dry run
 * guarantees.
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
      if (typeof body?.dryRun === "boolean") {
        dryRun = body.dryRun;
      }
    } catch {
      // No body, or not JSON -- fine, dryRun stays as resolved from the query string.
    }
  }

  const traceId = await startTrace({
    module: "notion",
    sourceType: "execute",
    summary: dryRun ? "Execute → Notion sync (dry run)" : "Execute → Notion sync",
  });

  try {
    const summary = await syncExecuteToNotion({ dryRun, traceId });

    const totalErrors = summary.errors.length;
    await completeTrace(traceId, {
      status: totalErrors > 0 ? "failed" : "completed",
      summary: dryRun
        ? "Execute → Notion dry run completed"
        : `Execute → Notion sync completed with ${totalErrors} error(s)`,
    });

    return NextResponse.json({ success: true, traceId, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Notion sync error";
    console.error("Execute → Notion sync failed:", error);

    await completeTrace(traceId, { status: "failed", summary: message });
    await recordIssue({
      traceId,
      issueType: "notion_sync_run_failed",
      severity: "critical",
      humanSummary: "Execute → Notion sync run failed",
      retryable: true,
      technicalDetail: message,
    });

    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
