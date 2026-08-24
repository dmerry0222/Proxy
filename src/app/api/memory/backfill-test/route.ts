import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  backfillRecentEmails,
} from "@/lib/memory/backfillEmails";

export async function POST(
  request: NextRequest
) {
  try {
    const body =
      await request.json();

    const days =
      Number(
        body.days ??
        30
      );

    const limit =
      Number(
        body.limit ??
        25
      );

    const safeDays =
      Number.isFinite(days)
        ? Math.min(
            Math.max(
              Math.floor(
                days
              ),
              1
            ),
            365
          )
        : 30;

    const safeLimit =
      Number.isFinite(limit)
        ? Math.min(
            Math.max(
              Math.floor(
                limit
              ),
              1
            ),
            100
          )
        : 25;

    const result =
      await backfillRecentEmails({
        days:
          safeDays,

        limit:
          safeLimit,
      });

    return NextResponse.json(
      result
    );
  } catch (error) {
    console.error(
      "Memory backfill test failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof
            Error
            ? error.message
            : "Unknown error",
      },
      {
        status: 500,
      }
    );
  }
}