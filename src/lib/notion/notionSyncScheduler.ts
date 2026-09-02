import "server-only";

import { startTrace, completeTrace } from "@/lib/diagnostics/emitEvent";
import { ingestMailroomNeedsAttention } from "@/lib/execute/mailroomIntake";
import { refreshExecuteCuration } from "@/lib/execute/refreshCuration";
import { pullExecuteFromNotion } from "@/lib/notion/pullExecute";
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
    summary: "Periodic Execute cycle: Notion pull, Mailroom intake, curation, Notion push",
  });
  try {
    /*
     * Order matters, and it is a cycle rather than a push:
     *
     *   1. PULL   -- adopt what Dave changed in Notion (planning dates,
     *                project filing, plateaus) before anything recomputes on
     *                top of stale state.
     *   2. INTAKE -- turn newly classified Needs Attention mail into durable
     *                execution items.
     *   3. CURATE -- decide what deserves the curated surface, now that both
     *                human input and new work are in.
     *   4. PUSH   -- project the result back out.
     *
     * Each stage is caught on its own: a Notion outage must not stop intake
     * from happening, and a Mailroom problem must not stop the projection.
     */
    let pullSummary = "";
    try {
      const pull = await pullExecuteFromNotion({ dryRun: false, traceId });
      pullSummary = ` Pull: ${pull.projects.changed + pull.items.changed + pull.milestones.changed + pull.meetings.changed} change(s), ${pull.projects.adopted + pull.milestones.adopted} adopted.`;
    } catch (error) {
      console.error("Notion -> Execute pull failed:", error);
      pullSummary = ` Pull failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

    let intakeSummary = "";
    try {
      const intake = await ingestMailroomNeedsAttention();
      const curation = await refreshExecuteCuration();
      intakeSummary = ` Intake: ${intake.created} created, ${intake.refreshed} refreshed, ${intake.withdrawn} withdrawn. Curation: ${curation.curated} curated / ${curation.suppressed} suppressed (${curation.changed} changed).`;
    } catch (error) {
      console.error("Mailroom -> Execute intake failed:", error);
      intakeSummary = ` Intake failed: ${error instanceof Error ? error.message : "Unknown error"}`;
    }

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
      summary: `Execute: ${execute.projects.created + execute.items.created + execute.milestones.created + execute.meetings.created + execute.workBlocks.created} created, ${execute.projects.updated + execute.items.updated + execute.milestones.updated + execute.meetings.updated + execute.workBlocks.updated} updated, ${execute.projects.skipped + execute.items.skipped + execute.milestones.skipped + execute.meetings.skipped + execute.workBlocks.skipped} unchanged, ${execute.errors.length} failed.${pullSummary}${intakeSummary}${mailroomSummary}`,
    });
  } catch (error) {
    console.error("Notion sync sweep failed:", error);
    await completeTrace(traceId, { status: "failed", summary: error instanceof Error ? error.message : "Unknown error" });
  }
}

/**
 * Runs the Execute cycle -- pull human edits from Notion, take in newly
 * classified Needs Attention mail, recompute curation, push everything back
 * out -- plus the Mailroom projection, without requiring every mutation path
 * (reconciliation, CoS, review actions, Mailroom analysis runs, manual
 * Execute mutations) to know how to talk to Notion.
 *
 * For anyone tempted to replace this with a scheduled job: this project is on
 * Vercel Hobby, where a cron more frequent than daily breaks the deployment.
 * Recurring work belongs to this in-process sweep or an external scheduler
 * (Power Automate, Supabase), not to a new vercel.json cron entry.
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
