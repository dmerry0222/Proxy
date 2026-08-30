import { NextRequest, NextResponse } from "next/server";

import { backfillRecentTeamsMessages } from "@/lib/memory/backfillTeamsMessages";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = Math.min(Math.max(Math.floor(Number(body.days ?? 30)), 1), 365);
    const limit = Math.min(Math.max(Math.floor(Number(body.limit ?? 25)), 1), 100);
    return NextResponse.json(await backfillRecentTeamsMessages({ days, limit }));
  } catch (error) {
    console.error("Teams Memory backfill test failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
