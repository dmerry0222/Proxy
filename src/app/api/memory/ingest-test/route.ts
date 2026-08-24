import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  ingestEmailToMemory,
} from "@/lib/memory/ingestEmail";

export async function POST(
  request: NextRequest
) {
  try {
    const body =
      await request.json();

    const outlookMessageId =
      body.outlookMessageId;

    if (
      !outlookMessageId
    ) {
      return NextResponse.json(
        {
          error:
            "Missing outlookMessageId",
        },
        {
          status: 400,
        }
      );
    }

    const result =
      await ingestEmailToMemory(
        outlookMessageId
      );

    return NextResponse.json(
      result
    );
  } catch (error) {
    console.error(
      "Memory ingestion test failed:",
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