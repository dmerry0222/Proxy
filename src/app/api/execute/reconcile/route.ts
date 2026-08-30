import { NextResponse } from "next/server";

import { reconcileWorkBlocksFromCalendar } from "@/lib/execute/reconcileWorkBlocks";

export async function POST() {
  try {
    return NextResponse.json({ success: true, ...(await reconcileWorkBlocksFromCalendar()) });
  } catch (error) {
    console.error("Execute reconciliation failed:", error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown reconciliation error",
    }, { status: 500 });
  }
}

