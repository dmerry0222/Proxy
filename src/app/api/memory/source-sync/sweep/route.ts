import { NextResponse } from "next/server";

import { sweepPendingSourceSyncRuns } from "@/lib/memory/sourceSyncRuns";

export async function POST() {
  try {
    return NextResponse.json({ success: true, ...(await sweepPendingSourceSyncRuns()) });
  } catch (error) {
    console.error("Memory source_sync_runs sweep failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
