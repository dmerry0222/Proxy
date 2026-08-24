import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";

export async function GET(
  request: Request
) {
  try {
    const url =
      new URL(
        request.url
      );

    const runId =
      url.searchParams.get(
        "runId"
      );

    if (!runId) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Missing runId",
        },
        {
          status: 400,
        }
      );
    }

    const {
      data: run,
      error,
    } =
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .select(
          `
          id,
          status,
          error_message
          `
        )
        .eq(
          "id",
          runId
        )
        .maybeSingle();

    if (error) {
      throw new Error(
        `Could not check Mailroom run: ${error.message}`
      );
    }

    if (!run) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Mailroom run not found",
        },
        {
          status: 404,
        }
      );
    }

    return NextResponse.json({
      success: true,
      runId:
        run.id,
      status:
        run.status,
      error:
        run.error_message ??
        null,
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
      {
        status: 500,
      }
    );
  }
}
