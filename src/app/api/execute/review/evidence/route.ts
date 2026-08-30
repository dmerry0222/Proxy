import { NextResponse } from "next/server";

import { loadItemEvidence } from "@/lib/execute/loadItemEvidence";

export async function GET(request: Request) {
  try {
    const itemId = new URL(request.url).searchParams.get("itemId");
    if (!itemId) return NextResponse.json({ success: false, error: "itemId is required" }, { status: 400 });
    const evidence = await loadItemEvidence(itemId);
    return NextResponse.json({ success: true, result: { evidence } });
  } catch (error) {
    console.error("Evidence lookup failed:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unknown evidence error" }, { status: 500 });
  }
}
