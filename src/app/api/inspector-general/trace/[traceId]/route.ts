import { NextResponse } from "next/server";

import { loadTraceDetail } from "@/lib/diagnostics/loadTrace";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ traceId: string }> },
) {
  try {
    const { traceId } = await params;
    const detail = await loadTraceDetail(traceId);

    if (!detail) {
      return NextResponse.json({ success: false, error: "Trace not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true, result: detail });
  } catch (error) {
    console.error("Inspector General trace lookup failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown Inspector General trace error",
      },
      { status: 500 },
    );
  }
}
