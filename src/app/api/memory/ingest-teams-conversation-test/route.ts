import { NextRequest, NextResponse } from "next/server";

import { processTeamsConversationDelta } from "@/lib/memory/processTeamsConversationDelta";

/**
 * Test-only entry point for the conversation-delta-level Teams processor
 * (as opposed to /api/memory/ingest-teams-test, which exercises the older
 * single-message pathway in ingestTeamsMessage.ts). No existing route
 * called processTeamsConversationDelta directly by chat_id -- it's
 * normally driven by processTeamsSyncRun via a sync-completion signal.
 * Matches the existing ingest-test/ingest-teams-test/backfill-teams-test
 * convention.
 */
export async function POST(request: NextRequest) {
  try {
    const { chatId } = await request.json();
    if (!chatId || typeof chatId !== "string") {
      return NextResponse.json({ error: "Missing chatId" }, { status: 400 });
    }
    return NextResponse.json(await processTeamsConversationDelta(chatId));
  } catch (error) {
    console.error("Teams conversation-delta test failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
