import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { runMailroomAnalysis } from "@/lib/mailroom/analyzeMailroom";

export async function GET(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

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