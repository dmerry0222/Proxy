import { NextResponse } from "next/server";

import { applyReconciliationReviewAction } from "@/lib/execute/reviewActions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await applyReconciliationReviewAction(body);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Reconciliation review action failed:", error);
    const message = error instanceof Error ? error.message : "Unknown reconciliation review error";
    const status = /required|valid|must|not found|no longer pending|Cannot merge/i.test(message) ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
