import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { runNotionExecuteSweep } from "@/lib/notion/notionSyncScheduler";

/**
 * pg_cron-driven caller for the Execute/Calendar/Mailroom Notion sweep
 * (pull -> intake -> curate -> push), for the same reason
 * mailroom/maintenance/route.ts exists: the in-process setInterval in
 * notionSyncScheduler.ts assumes a long-lived Node process, which Vercel's
 * serverless runtime does not reliably provide. This route and the interval
 * both call the same runNotionExecuteSweep(), so there is one implementation,
 * not two.
 *
 * Protected identically to every other admin route: `Authorization: Bearer
 * <PROXY_ADMIN_API_TOKEN>`.
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

  await runNotionExecuteSweep();

  return NextResponse.json({ success: true });
}
