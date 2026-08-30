import { NextResponse } from "next/server";

import { retryDiagnosticIssue } from "@/lib/diagnostics/retryIssue";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ issueId: string }> },
) {
  try {
    const { issueId } = await params;
    const result = await retryDiagnosticIssue(issueId);

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Inspector General issue retry failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown Inspector General retry error",
      },
      { status: 500 },
    );
  }
}
