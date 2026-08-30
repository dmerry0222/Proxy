import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, startTrace } from "@/lib/diagnostics/emitEvent";
import { reconcileNotionSubmission } from "@/lib/mailroom/reconcileNotionSubmission";

/**
 * Row-level Notion Mailroom submission intake.
 *
 * Body: `{ notionPageId }` or `{ conversationId }` (canonical Outlook
 * conversation id). The eventual Notion button sends the page id; the
 * conversation id form exists so this is testable locally and re-runnable
 * from Proxy without a Notion round trip.
 *
 * Currently protected by PROXY_ADMIN_API_TOKEN. The Notion-webhook
 * verification path (NOTION_WEBHOOK_SECRET + a public URL) is not wired up
 * yet -- see getNotionWebhookSecret in lib/notion/client.ts. That is the
 * only remaining gap between this handler and a working Notion button; the
 * reconciliation itself is complete and exercised by the local tests.
 *
 * Performs NO Outlook mutation and enqueues no execution command: this
 * records review, not execution.
 */
export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  let body: { notionPageId?: string; conversationId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "A JSON body is required." }, { status: 400 });
  }

  if (!body?.notionPageId && !body?.conversationId) {
    return NextResponse.json(
      { success: false, error: "notionPageId or conversationId is required." },
      { status: 400 }
    );
  }

  const traceId = await startTrace({
    module: "mailroom",
    sourceType: "notion",
    summary: "Notion Mailroom row submission",
  });

  try {
    const result = await reconcileNotionSubmission({
      notionPageId: body.notionPageId ?? null,
      conversationId: body.conversationId ?? null,
      traceId,
    });

    await completeTrace(traceId, {
      status: result.ok ? "completed" : "failed",
      summary: result.ok
        ? `Submission reconciled (${result.changedFields.length} field(s) changed by Dave)`
        : (result.error ?? "Submission failed"),
    });

    return NextResponse.json({ success: result.ok, traceId, ...result }, { status: result.ok ? 200 : 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Notion Mailroom submission failed:", error);
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
