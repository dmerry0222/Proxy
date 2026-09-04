import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

/**
 * Serializes the Notion Execute pull/push cycle across every caller: the
 * in-process interval, the pg_cron-triggered /api/notion/maintenance route,
 * and the standalone /api/notion/pull-execute / /api/notion/sync-execute
 * admin routes. Found live (Priority 6 validation): a manual pull-execute
 * call overlapping the scheduled sweep produced duplicate
 * execute_touchpoint_audit rows for the same human edit -- setMeetingPlateau
 * is idempotent on final state, but the read-then-write race let both
 * callers compute the same "previous" value before either committed.
 *
 * A durable lease row (ops.maintenance_leases via the public wrapper RPCs),
 * not a session-scoped advisory lock -- PostgREST/supabase-js calls aren't
 * guaranteed to reuse the same underlying connection across two separate
 * .rpc() invocations, so a plain pg_advisory_lock/unlock pair could acquire
 * and release on different sessions and never actually serialize anything.
 */
export async function withAppLease<T>(name: string, ttlMinutes: number, fn: () => Promise<T>): Promise<T | { skipped: true }> {
  const { data: acquired, error } = await supabaseServer.rpc("try_acquire_app_lease", {
    p_name: name,
    p_ttl: `${ttlMinutes} minutes`,
  });
  if (error) throw new Error(`Could not acquire lease "${name}": ${error.message}`);
  if (!acquired) return { skipped: true };

  try {
    return await fn();
  } finally {
    await supabaseServer.rpc("release_app_lease", { p_name: name });
  }
}
