import { NextResponse } from "next/server";

import { runPriorityAssessment } from "@/lib/cos/runPriorityAssessment";

/**
 * Manually-triggered bounded prioritization pass (Post-Phase-6 Part 15/16):
 * explicit request, never a synchronous rerun on every source event. A
 * future scheduled_review trigger can call this same function on a cron;
 * this route is the manual_request entry point plus the live-test surface.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const scope = body.scope === "project" || body.scope === "item" ? body.scope : "all_active";
    const scopeRef = typeof body.scopeRef === "string" ? body.scopeRef : undefined;
    const result = await runPriorityAssessment({ trigger: "manual_request", scope, scopeRef });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("Priority assessment run failed:", error);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
