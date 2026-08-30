import { NextResponse } from "next/server";

import { recordMailroomCommandResult } from "@/lib/mailroom/mailroomCommands";

/**
 * Power Automate reports the outcome of an Outlook mutation here (Build
 * Part 10/12). Authenticated with a separate shared secret rather than
 * the admin bearer token -- this endpoint is called by an external flow,
 * not by anything inside Proxy, so it gets its own narrower credential.
 */
export async function POST(request: Request) {
  try {
    const expected = process.env.POWER_AUTOMATE_MAILROOM_SECRET;
    if (expected) {
      const provided = request.headers.get("x-proxy-secret");
      if (provided !== expected) {
        return NextResponse.json({ success: false, error: "Invalid secret" }, { status: 401 });
      }
    }

    const body = await request.json();
    const { commandId, success, error, draftId, eventId, outlookMessageId, webLink } = body;
    if (!commandId || typeof success !== "boolean") {
      return NextResponse.json({ success: false, error: "commandId and success are required" }, { status: 400 });
    }

    const result = await recordMailroomCommandResult({ commandId, success, error, draftId, eventId, outlookMessageId, webLink });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Mailroom command callback failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
