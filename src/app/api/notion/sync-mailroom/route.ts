import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { syncMailroomToNotion } from "@/lib/notion/syncMailroom";

/**
 * Manually triggered Mailroom -> Notion projection (Brief Part 2).
 *
 * Read-only projection only -- does not create the "Submit to Proxy"
 * automation (that's configured by hand in Notion, watching Review
 * Status) and there is no inbound webhook yet, so nothing a human edits
 * in the resulting Notion pages affects Proxy. Not wired to a cron,
 * webhook, or page load. Requires `Authorization: Bearer
 * <PROXY_ADMIN_API_TOKEN>`; see src/lib/auth/adminAuth.ts.
 *
 * Body/query: `dryRun` (bool, default false) and `limit` (number, apply
 * mode only -- caps how many conversations are actually pushed to Notion
 * in one call; dry run always evaluates the full live Inbox set since it
 * never calls Notion).
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
  let limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null;

  if (request.headers.get("content-length") !== "0") {
    try {
      const body = await request.json();
      if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
      if (typeof body?.limit === "number") limit = body.limit;
    } catch {
      // No body, or not JSON -- fine, values stay as resolved from the query string.
    }
  }

  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
    return NextResponse.json({ success: false, error: "limit must be a non-negative number." }, { status: 400 });
  }

  const traceId = await startTrace({
    module: "notion",
    sourceType: "mailroom",
    summary: dryRun ? "Mailroom → Notion sync (dry run)" : "Mailroom → Notion sync",
  });

  try {
    const summary = await syncMailroomToNotion({ dryRun, traceId, limit });

    const totalErrors = summary.errors.length;
    await completeTrace(traceId, {
      status: totalErrors > 0 ? "failed" : "completed",
      summary: dryRun
        ? "Mailroom → Notion dry run completed"
        : `Mailroom → Notion sync completed with ${totalErrors} error(s)`,
    });

    return NextResponse.json({ success: true, traceId, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Notion sync error";
    console.error("Mailroom → Notion sync failed:", error);

    await completeTrace(traceId, { status: "failed", summary: message });
    await recordIssue({
      traceId,
      issueType: "notion_sync_run_failed",
      severity: "critical",
      humanSummary: "Mailroom → Notion sync run failed",
      retryable: true,
      technicalDetail: message,
    });

    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
