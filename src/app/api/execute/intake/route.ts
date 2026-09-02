import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { ingestMailroomNeedsAttention } from "@/lib/execute/mailroomIntake";
import { refreshExecuteCuration } from "@/lib/execute/refreshCuration";

/**
 * Runs the Mailroom -> Execute intake, then recomputes curation so the new
 * items arrive with a stated reason rather than as unexplained rows.
 *
 * Admin-gated and explicitly invoked. The same pair also runs inside the
 * Notion sweep (notionSyncScheduler.ts); this route exists to run it on
 * demand -- after a Mailroom analysis run, or when checking what intake
 * would do -- without waiting for the sweep.
 *
 * Deliberately NOT a Vercel Cron: this project is on the Hobby plan, where
 * anything more frequent than daily breaks the deployment. Recurring
 * execution belongs to an external scheduler (Power Automate, Supabase) or
 * the in-process sweep.
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

  try {
    const intake = await ingestMailroomNeedsAttention();
    const curation = await refreshExecuteCuration();

    return NextResponse.json({ success: true, intake, curation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Execute intake error";
    console.error("Mailroom → Execute intake failed:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
