import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  handleSourceSyncRunChange,
  sweepPendingSourceSyncRuns,
} from "@/lib/memory/sourceSyncRuns";

declare global {
  var __memorySourceSyncListenerStarted: boolean | undefined;
}

/*
 * Guards against Next.js re-invoking register() across hot reloads/module
 * re-evaluation in dev, which would otherwise open a duplicate Realtime
 * subscription each time.
 */
export async function startMemorySourceSyncListener() {
  if (globalThis.__memorySourceSyncListenerStarted) {
    return;
  }

  globalThis.__memorySourceSyncListenerStarted = true;

  await sweepPendingSourceSyncRuns().catch((error) => {
    console.error("Initial Memory source_sync_runs sweep failed:", error);
  });

  supabaseServer
    .channel("memory-source-sync-runs")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "source_sync_runs" },
      (payload) => {
        void handleSourceSyncRunChange(payload.new);
      }
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "source_sync_runs" },
      (payload) => {
        void handleSourceSyncRunChange(payload.new);
      }
    )
    .subscribe((status) => {
      console.log(`Memory source_sync_runs Realtime channel status: ${status}`);

      /*
       * Realtime is the wake-up signal, never the sole source of truth
       * (per design). A reconnect after CHANNEL_ERROR/TIMED_OUT/CLOSED may
       * have missed events, so sweep again once the channel comes back.
       */
      if (status === "SUBSCRIBED") {
        void sweepPendingSourceSyncRuns().catch((error) => {
          console.error("Post-(re)connect Memory source_sync_runs sweep failed:", error);
        });
      }
    });
}
