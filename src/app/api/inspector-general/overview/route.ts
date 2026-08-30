import { NextResponse } from "next/server";

import { loadInspectorGeneralOverview } from "@/lib/diagnostics/loadOverview";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const overview = await loadInspectorGeneralOverview();

    return NextResponse.json({ success: true, result: overview });
  } catch (error) {
    console.error("Inspector General overview failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown Inspector General overview error",
      },
      { status: 500 },
    );
  }
}
