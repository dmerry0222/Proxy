import { NextResponse } from "next/server";

import { requireAdminAuth } from "@/lib/auth/adminAuth";
import { backfillCalendarWindow, backfillEmailBatch, backfillTeamsBatch } from "@/lib/reconciliation/backfillHistoricalOperations";

/**
 * Historical/manual backfill is deliberately capped well above any
 * single real run seen so far (21 days) but still bounded -- this is not
 * meant to become a mechanism for reconciling arbitrary spans of history
 * in one call. A wider window is a decision to make explicitly, not a
 * request this route should silently accept.
 */
const MAX_WINDOW_DAYS = 45;
const MAX_BATCH_SIZE = 100;

export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
    const body = await request.json();
    const { source, windowStart, windowEnd, runId, batchSize } = body;

    if (!windowStart || !windowEnd) {
      return NextResponse.json({ success: false, error: "windowStart and windowEnd are required" }, { status: 400 });
    }
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return NextResponse.json({ success: false, error: "windowStart and windowEnd must be valid timestamps" }, { status: 400 });
    }
    if (end.getTime() <= start.getTime()) {
      return NextResponse.json({ success: false, error: "windowEnd must be after windowStart" }, { status: 400 });
    }
    const windowDays = (end.getTime() - start.getTime()) / 86_400_000;
    if (windowDays > MAX_WINDOW_DAYS) {
      return NextResponse.json({ success: false, error: `Window cannot exceed ${MAX_WINDOW_DAYS} days (requested ${windowDays.toFixed(1)}).` }, { status: 400 });
    }
    if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE)) {
      return NextResponse.json({ success: false, error: `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.` }, { status: 400 });
    }

    if (source === "email") {
      const result = await backfillEmailBatch({ windowStart, windowEnd, batchSize: batchSize ?? 25, runId });
      return NextResponse.json({ success: true, result });
    }
    if (source === "teams") {
      const result = await backfillTeamsBatch({ windowStart, windowEnd, runId });
      return NextResponse.json({ success: true, result });
    }
    if (source === "calendar") {
      const result = await backfillCalendarWindow({ windowStart, windowEnd });
      return NextResponse.json({ success: true, result });
    }
    return NextResponse.json({ success: false, error: "source must be email, teams, or calendar" }, { status: 400 });
  } catch (error) {
    console.error("Historical backfill batch failed:", error);
    const status = error instanceof Error && error.constructor.name === "AdminAuthError" ? 401 : 500;
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, { status });
  }
}
