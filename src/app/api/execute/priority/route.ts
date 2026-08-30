import { NextResponse } from "next/server";

import { applyPriorityAction } from "@/lib/cos/priorityActions";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await applyPriorityAction(body);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Priority action failed:", error);
    const message = error instanceof Error ? error.message : "Unknown priority action error";
    const status = /required|valid|Invalid|not found/i.test(message) ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
