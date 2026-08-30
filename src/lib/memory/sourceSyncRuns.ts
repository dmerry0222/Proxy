import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { processTeamsSyncRun } from "@/lib/memory/processTeamsSyncRun";
import { processCalendarSyncRun } from "@/lib/memory/processCalendarSyncRun";
import { processEmailSyncRun } from "@/lib/memory/processEmailSyncRun";

const TEAMS_PROCESSOR_VERSION = 1;
const CALENDAR_PROCESSOR_VERSION = 1;
const EMAIL_PROCESSOR_VERSION = 1;

const ELIGIBLE_SOURCE_TYPES = new Set(["teams", "calendar", "email"]);

type SourceSyncRunRow = {
  id: string;
  status: string | null;
  memory_status: string | null;
  source_type: string | null;
  external_run_id: string | null;
  metadata: Record<string, unknown> | null;
};

function isEligible(
  row: Partial<SourceSyncRunRow> | null | undefined
): row is SourceSyncRunRow {
  return (
    !!row &&
    !!row.id &&
    row.status === "completed" &&
    row.memory_status === "pending" &&
    !!row.source_type &&
    ELIGIBLE_SOURCE_TYPES.has(row.source_type)
  );
}

/*
 * Called from the Realtime INSERT/UPDATE callback. Realtime hands us the
 * row already, but we still re-check eligibility here because the row
 * shape/content in the payload is not guaranteed to be exactly what a
 * fresh SELECT would return, and because processSourceSyncRun below does
 * its own authoritative re-fetch + conditional claim anyway.
 */
export async function handleSourceSyncRunChange(row: unknown) {
  const candidate = row as Partial<SourceSyncRunRow> | null;

  if (!isEligible(candidate)) {
    return;
  }

  try {
    await processSourceSyncRun(candidate.id);
  } catch (error) {
    console.error(
      `Memory source_sync_runs processing failed for run ${candidate.id}:`,
      error
    );
  }
}

/*
 * Realtime is the wake-up signal, not the source of truth. This sweep is
 * the fallback: run it on startup/reconnect and it will pick up anything
 * a missed Realtime event left behind.
 */
export async function sweepPendingSourceSyncRuns() {
  const { data, error } = await supabaseServer
    .from("source_sync_runs")
    .select("id, status, memory_status, source_type, external_run_id, metadata")
    .eq("status", "completed")
    .eq("memory_status", "pending")
    .in("source_type", ["teams", "calendar", "email"])
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not sweep pending source_sync_runs: ${error.message}`);
  }

  const results = [];

  for (const row of data ?? []) {
    try {
      results.push({ runId: row.id, result: await processSourceSyncRun(row.id) });
    } catch (cause) {
      console.error(`Memory source_sync_runs sweep failed for run ${row.id}:`, cause);
      results.push({
        runId: row.id,
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }
  }

  return { swept: (data ?? []).length, results };
}

export async function processSourceSyncRun(runId: string) {
  const { data: row, error: loadError } = await supabaseServer
    .from("source_sync_runs")
    .select("id, status, memory_status, source_type, external_run_id, metadata")
    .eq("id", runId)
    .maybeSingle();

  if (loadError) {
    throw new Error(`Could not load source_sync_runs row ${runId}: ${loadError.message}`);
  }

  if (!isEligible(row)) {
    return { processed: false as const, reason: "not_eligible" as const };
  }

  const processorVersion =
    row.source_type === "teams"
      ? TEAMS_PROCESSOR_VERSION
      : row.source_type === "calendar"
        ? CALENDAR_PROCESSOR_VERSION
        : EMAIL_PROCESSOR_VERSION;

  /*
   * Conditional update is the claim. Only the caller whose UPDATE actually
   * matched memory_status = 'pending' gets a row back; a concurrent
   * Realtime callback and startup sweep racing on the same run will have
   * exactly one winner.
   */
  const { data: claimed, error: claimError } = await supabaseServer
    .from("source_sync_runs")
    .update({
      memory_status: "processing",
      memory_started_at: new Date().toISOString(),
      memory_processor_version: processorVersion,
      memory_error: null,
    })
    .eq("id", runId)
    .eq("memory_status", "pending")
    .select("id, source_type, external_run_id, metadata")
    .maybeSingle();

  if (claimError) {
    throw new Error(`Could not claim source_sync_runs row ${runId}: ${claimError.message}`);
  }

  if (!claimed) {
    return { processed: false as const, reason: "already_claimed" as const };
  }

  try {
    if (claimed.source_type === "teams") {
      if (!claimed.external_run_id) {
        throw new Error("Teams source_sync_runs row is missing external_run_id");
      }

      await processTeamsSyncRun(claimed.external_run_id);
    } else if (claimed.source_type === "calendar") {
      if (!claimed.external_run_id) {
        throw new Error("Calendar source_sync_runs row is missing external_run_id");
      }

      const metadata = (claimed.metadata ?? {}) as Record<string, unknown>;
      const windowStart =
        typeof metadata.window_start === "string" ? metadata.window_start : null;
      const windowEnd = typeof metadata.window_end === "string" ? metadata.window_end : null;

      if (!windowStart || !windowEnd) {
        throw new Error(
          "Calendar source_sync_runs row is missing metadata.window_start/window_end"
        );
      }

      await processCalendarSyncRun({
        runGuid: claimed.external_run_id,
        windowStart,
        windowEnd,
      });
    } else if (claimed.source_type === "email") {
      const metadata = (claimed.metadata ?? {}) as Record<string, unknown>;
      const scope = typeof metadata.scope === "string" ? metadata.scope : "all";

      await processEmailSyncRun(scope);
    }

    const { error: completeError } = await supabaseServer
      .from("source_sync_runs")
      .update({
        memory_status: "complete",
        memory_completed_at: new Date().toISOString(),
        memory_error: null,
      })
      .eq("id", runId);

    if (completeError) {
      throw new Error(`Could not mark source_sync_runs run complete: ${completeError.message}`);
    }

    return { processed: true as const };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "Unknown Memory source-sync processing error";

    const { error: failError } = await supabaseServer
      .from("source_sync_runs")
      .update({ memory_status: "failed", memory_error: message })
      .eq("id", runId);

    if (failError) {
      console.error(`Could not mark source_sync_runs run failed: ${failError.message}`);
    }

    throw cause;
  }
}
