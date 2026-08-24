import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  ingestRecentEmailsForSender,
} from "@/lib/memory/ingestRecentEmails";

export async function POST(
  request: NextRequest
) {
  try {
    const body =
      await request.json();

    const email =
      body.email;

    const limit =
      Number(
        body.limit ??
        8
      );

    if (!email) {
      return NextResponse.json(
        {
          error:
            "Missing email",
        },
        {
          status: 400,
        }
      );
    }

    const safeLimit =
      Number.isFinite(limit)
        ? Math.min(
            Math.max(
              Math.floor(limit),
              1
            ),
            10
          )
        : 8;

    const results =
      await ingestRecentEmailsForSender(
        email,
        safeLimit
      );

    return NextResponse.json({
      email,
      requested:
        safeLimit,
      processed:
        results.length,
      results,
    });
  } catch (error) {
    console.error(
      "Memory batch ingestion test failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      {
        status: 500,
      }
    );
  }
}