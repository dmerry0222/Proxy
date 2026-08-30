import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, startTrace } from "@/lib/diagnostics/emitEvent";
import { migrateMailroomSchema } from "@/lib/notion/migrateMailroomSchema";

/**
 * Migrates the live Notion Mailroom data source to the schema Proxy
 * expects, and returns the before/after diagnostic.
 *
 * Exists separately from /api/notion/sync-mailroom (which now runs the same
 * migration as its first step) so the schema state can be inspected and
 * repaired WITHOUT pushing 60+ pages -- and so `dryRun` can answer "what is
 * actually different right now" as a read-only question.
 *
 * Idempotent: when the live schema already matches, no Notion write is
 * issued and `alreadyInSync` comes back true.
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

  if (request.headers.get("content-length") !== "0") {
    try {
      const body = await request.json();
      if (typeof body?.dryRun === "boolean") dryRun = body.dryRun;
    } catch {
      // No body / not JSON -- keep the query-string value.
    }
  }

  const traceId = await startTrace({
    module: "notion",
    sourceType: "mailroom",
    summary: dryRun ? "Notion Mailroom schema migration (dry run)" : "Notion Mailroom schema migration",
  });

  try {
    const report = await migrateMailroomSchema({ dryRun, traceId });

    await completeTrace(traceId, {
      status: report.error ? "failed" : "completed",
      summary: report.error
        ? report.error
        : report.alreadyInSync
          ? "Notion Mailroom schema already in sync"
          : `Added ${report.propertiesAdded.length}, changed ${report.propertiesChanged.length} propert(ies)`,
    });

    return NextResponse.json({ success: report.error === null, traceId, ...report }, { status: report.error ? 500 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Notion Mailroom schema migration failed:", error);
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
