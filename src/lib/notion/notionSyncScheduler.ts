import "server-only";

import { startTrace, completeTrace } from "@/lib/diagnostics/emitEvent";
import { syncExecuteToNotion } from "@/lib/notion/syncExecute";

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
    summary: "Periodic Execute -> Notion surface sweep",
  });
  try {
    const summary = await syncExecuteToNotion({ dryRun: false, traceId });
    await completeTrace(traceId, {
      status: summary.errors.length ? "failed" : "completed",
      summary: `Sweep: ${summary.projects.created + summary.items.created + summary.workBlocks.created} created, ${summary.projects.updated + summary.items.updated + summary.workBlocks.updated} updated, ${summary.projects.skipped + summary.items.skipped + summary.workBlocks.skipped} unchanged, ${summary.errors.length} failed.`,
    });
  } catch (error) {
    console.error("Notion sync sweep failed:", error);
    await completeTrace(traceId, { status: "failed", summary: error instanceof Error ? error.message : "Unknown error" });
  }
}

/**
 * Keeps the Notion Execute surface (Projects/Execution Items/Work Blocks)
 * synchronized without requiring every mutation path (reconciliation, CoS,
 * review actions, manual Execute mutations) to know how to talk to Notion.
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

  globalThis.__notionSyncSchedulerStarted = true;

  void runSweep();
  setInterval(() => {
    void runSweep();
  }, intervalMs());

  console.log(`Notion sync scheduler started (every ${intervalMs() / 60_000} minute(s)).`);
}
