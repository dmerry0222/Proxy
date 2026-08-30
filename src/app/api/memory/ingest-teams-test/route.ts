import { NextRequest, NextResponse } from "next/server";

import { ingestTeamsMessageToMemory } from "@/lib/memory/ingestTeamsMessage";

export async function POST(request: NextRequest) {
  try {
    const { messageId } = await request.json();
    if (!messageId || typeof messageId !== "string") {
      return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
    }
    return NextResponse.json(await ingestTeamsMessageToMemory(messageId));
  } catch (error) {
    console.error("Teams Memory ingestion test failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
