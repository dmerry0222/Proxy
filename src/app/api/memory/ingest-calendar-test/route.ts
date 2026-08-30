import { NextRequest, NextResponse } from "next/server";

import { processCalendarSyncRun } from "@/lib/memory/processCalendarSyncRun";

/**
 * Test-only entry point for Calendar sync processing, matching the
 * existing ingest-test/ingest-teams-test/ingest-teams-conversation-test
 * convention. processCalendarSyncRun scopes purely by time window (it
 * doesn't filter by run_guid), so this just needs windowStart/windowEnd
 * covering the event(s) to process.
 */
export async function POST(request: NextRequest) {
  try {
    const { windowStart, windowEnd, runGuid } = await request.json();
    if (!windowStart || !windowEnd) {
      return NextResponse.json({ error: "Missing windowStart or windowEnd" }, { status: 400 });
    }
    return NextResponse.json(
      await processCalendarSyncRun({ runGuid: runGuid ?? `test-${Date.now()}`, windowStart, windowEnd })
    );
  } catch (error) {
    console.error("Calendar sync test failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
