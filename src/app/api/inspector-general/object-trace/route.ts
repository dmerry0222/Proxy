import { NextResponse } from "next/server";

import { loadTraceIdForObject } from "@/lib/diagnostics/loadTraceForObject";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const objectType = searchParams.get("objectType");
    const objectId = searchParams.get("objectId");

    if (!objectType || !objectId) {
      return NextResponse.json({ success: false, error: "objectType and objectId are required." }, { status: 400 });
    }

    const traceId = await loadTraceIdForObject(objectType, objectId);

    return NextResponse.json({ success: true, result: { traceId } });
  } catch (error) {
    console.error("Inspector General object-trace lookup failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown Inspector General object-trace error",
      },
      { status: 500 },
    );
  }
}
