import "server-only";

import { startTrace, completeTrace } from "@/lib/diagnostics/emitEvent";
import { syncExecuteToNotion } from "@/lib/notion/syncExecute";
import { syncMailroomToNotion } from "@/lib/notion/syncMailroom";

declare global {
  var __notionSyncSchedulerStarted: boolean | undefined;
}

const DEFAULT_INTERVAL_MINUTES = 10;

function intervalMs(): number {
  const configured = Number(process.env.NOTION_SYNC_INTERVAL_MINUTES);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60_000;
}

async function runSweep(): Promise<void> {
  const traceId = await startTrace({
    module: "notion",
    sourceType: "scheduled_sweep",
    summary: "Periodic Execute + Mailroom -> Notion surface sweep",
  });
  try {
    const execute = await syncExecuteToNotion({ dryRun: false, traceId });

    /*
     * Mailroom is swept here too. Leaving it out is what let the live
     * Mailroom database drift: its schema patch and page projection only
     * ever ran from a manual POST to /api/notion/sync-mailroom, so a
     * schema change in code sat unapplied indefinitely while the Execute
     * surface stayed current and made the surface look healthy.
     *
     * Swept independently of Execute: a Mailroom failure must not stop
     * Execute from having synced (and vice versa), so each is caught on
     * its own and both outcomes land in the same trace.
     */
    let mailroomSummary = "";
    let mailroomFailed = false;
    try {
      const mailroom = await syncMailroomToNotion({ dryRun: false, traceId, limit: null });
      mailroomFailed = mailroom.errors.length > 0;
      mailroomSummary = ` Mailroom: ${mailroom.conversations.created} created, ${mailroom.conversations.updated} updated, ${mailroom.conversations.skipped} unchanged, ${mailroom.errors.length} failed.`;
    } catch (error) {
      mailroomFailed = true;
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Mailroom sweep failed:", error);
      mailroomSummary = ` Mailroom sweep failed: ${message}`;
    }

    await completeTrace(traceId, {
      status: execute.errors.length || mailroomFailed ? "failed" : "completed",
      summary: `Execute: ${execute.projects.created + execute.items.created + execute.workBlocks.created} created, ${execute.projects.updated + execute.items.updated + execute.workBlocks.updated} updated, ${execute.projects.skipped + execute.items.skipped + execute.workBlocks.skipped} unchanged, ${execute.errors.length} failed.${mailroomSummary}`,
    });
  } catch (error) {
    console.error("Notion sync sweep failed:", error);
    await completeTrace(traceId, { status: "failed", summary: error instanceof Error ? error.message : "Unknown error" });
  }
}

/**
 * Keeps the Notion surfaces -- Execute (Projects/Execution Items/Work
 * Blocks) and Mailroom (conversations) -- synchronized without requiring
 * every mutation path (reconciliation, CoS, review actions, Mailroom
 * analysis runs, manual Execute mutations) to know how to talk to Notion.
 *
 * No cron/scheduled-job framework exists anywhere in this repo, and this
 * app runs as a long-lived Node process (the same assumption
 * sourceSyncRealtimeListener.ts already makes) -- a periodic in-process
 * sweep is the smallest reliable mechanism available, and it doubles as
 * the safety net a change-driven trigger would still need: syncOne's
 * canonical-hash skip makes a full-table sweep cheap, so there is no
 * separate "queue" to build for the push direction. A transient Notion
 * failure on one object self-heals on the next sweep; a persistent one
 * stays visible via diagnostic_issues (see pageSync.ts) rather than
 * retrying silently forever.
 */
export function startNotionSyncScheduler(): void {
  if (globalThis.__notionSyncSchedulerStarted) return;
  if (!process.env.NOTION_API_TOKEN || !process.env.NOTION_PROXY_PARENT_PAGE_ID) {
    console.log("Notion sync scheduler not started: NOTION_API_TOKEN/NOTION_PROXY_PARENT_PAGE_ID not configured.");
    return;
  }
  /*
   * Opt-out for the boot sweep. The sweep fires immediately on process
   * start, which is right in production but takes the choice away when a
   * schema change needs to be applied and verified against a handful of
   * pages before touching the whole surface. Defaults to enabled -- only an
   * explicit "false" turns it off.
   */
  if (process.env.NOTION_SYNC_SCHEDULER_ENABLED === "false") {
    console.log("Notion sync scheduler disabled via NOTION_SYNC_SCHEDULER_ENABLED=false.");
    return;
  }

  globalThis.__notionSyncSchedulerStarted = true;

  void runSweep();
  setInterval(() => {
    void runSweep();
  }, intervalMs());

  console.log(`Notion sync scheduler started (every ${intervalMs() / 60_000} minute(s)).`);
}
