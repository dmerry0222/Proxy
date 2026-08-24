import { NextResponse } from "next/server";

import { runMailroomAnalysis } from "@/lib/mailroom/analyzeMailroom";

export async function GET() {
  try {
    const result = await runMailroomAnalysis();

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Mailroom run error",
      },
      {
        status: 500,
      }
    );
  }
}