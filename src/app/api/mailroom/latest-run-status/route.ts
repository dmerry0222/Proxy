import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
 * Mailroom runs form a single chronological lifeline: the AI
 * analysis run and the human-approved execution run are separate
 * rows, created one after another, never the same row transitioning
 * from "completed" to "ready_for_review".
 *
 * The newest row by created_at is always the frontier of that
 * lifeline, so an already-open Mailroom page can poll this endpoint
 * and react the moment the frontier reaches ready_for_review,
 * without guessing which row "the current run" is.
 */
export async function GET() {
  try {
    const { data: run, error } = await supabaseServer
      .from("mailroom_runs")
      .select("id, status, completed_at, error_message")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Could not load latest Mailroom run: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      run: run
        ? {
            id: run.id,
            status: run.status,
            completedAt: run.completed_at,
            errorMessage: run.error_message ?? null,
          }
        : null,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Mailroom run-status error",
      },
      { status: 500 },
    );
  }
}
