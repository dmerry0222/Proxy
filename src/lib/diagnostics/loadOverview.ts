import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { DiagnosticIssue, DiagnosticTrace } from "@/lib/diagnostics/types";

export type HealthState = "healthy" | "degraded" | "failing" | "stale" | "unknown";

export type HealthTile = {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
};

export type InspectorGeneralOverview = {
  health: HealthTile[];
  recentTraces: DiagnosticTrace[];
  openIssues: DiagnosticIssue[];
};

/*
 * Registry of module health checks. Each entry only needs to describe how
 * to compute its state from diagnostic_traces — adding a new module here is
 * additive and doesn't require touching the Inspector General UI.
 */
const HEALTH_CHECKS: Array<{
  key: string;
  label: string;
  module: string;
  sourceType: string | null;
  staleAfterMs: number;
}> = [
  {
    key: "memory_email",
    label: "Email",
    module: "memory",
    sourceType: "email",
    staleAfterMs: 1000 * 60 * 60 * 24,
  },
  {
    key: "notion_execute_sync",
    label: "Execute → Notion",
    module: "notion",
    sourceType: "execute",
    staleAfterMs: 1000 * 60 * 60 * 24 * 7,
  },
  {
    key: "notion_mailroom_sync",
    label: "Mailroom → Notion",
    module: "notion",
    sourceType: "mailroom",
    staleAfterMs: 1000 * 60 * 60 * 24 * 7,
  },
  {
    key: "action_reconciliation",
    label: "Action Reconciliation",
    module: "reconciliation",
    sourceType: null,
    staleAfterMs: 1000 * 60 * 60 * 24 * 7,
  },
  {
    key: "capture",
    label: "Capture",
    module: "capture",
    sourceType: "capture",
    /*
     * A fortnight, not a day. Capture is human-driven and bursty -- a quiet
     * week means Dave had a quiet week, not that the front door is broken --
     * so a short staleness window would cry wolf constantly. What this tile
     * is really watching for is the failure mode that matters: captures that
     * arrive and fail, which shows up as "degraded"/"failing" immediately
     * regardless of the staleness window.
     */
    staleAfterMs: 1000 * 60 * 60 * 24 * 14,
  },
];

async function computeHealthTile(
  check: (typeof HEALTH_CHECKS)[number]
): Promise<HealthTile> {
  let query = supabaseServer
    .from("diagnostic_traces")
    .select("status, started_at")
    .eq("module", check.module)
    .order("started_at", { ascending: false })
    .limit(20);

  if (check.sourceType) {
    query = query.eq("source_type", check.sourceType);
  }

  const { data, error } = await query;

  if (error) {
    return { key: check.key, label: check.label, state: "unknown", detail: "Could not load recent activity." };
  }

  const traces = data ?? [];

  if (traces.length === 0) {
    return { key: check.key, label: check.label, state: "unknown", detail: "No activity observed yet." };
  }

  const mostRecent = traces[0];
  const isStale = Date.now() - new Date(mostRecent.started_at).getTime() > check.staleAfterMs;
  const failedCount = traces.filter((trace) => trace.status === "failed").length;

  if (isStale) {
    return {
      key: check.key,
      label: check.label,
      state: "stale",
      detail: `Nothing processed since ${new Date(mostRecent.started_at).toLocaleString()}.`,
    };
  }

  if (failedCount >= traces.length / 2) {
    return {
      key: check.key,
      label: check.label,
      state: "failing",
      detail: `${failedCount} of the last ${traces.length} runs failed.`,
    };
  }

  if (failedCount > 0) {
    return {
      key: check.key,
      label: check.label,
      state: "degraded",
      detail: `${failedCount} of the last ${traces.length} runs failed.`,
    };
  }

  return {
    key: check.key,
    label: check.label,
    state: "healthy",
    detail: `Last processed ${new Date(mostRecent.started_at).toLocaleString()}.`,
  };
}

export async function loadInspectorGeneralOverview(): Promise<InspectorGeneralOverview> {
  const [health, tracesResult, issuesResult] = await Promise.all([
    Promise.all(HEALTH_CHECKS.map(computeHealthTile)),
    supabaseServer
      .from("diagnostic_traces")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(30),
    supabaseServer
      .from("diagnostic_issues")
      .select("*")
      .eq("status", "open")
      .order("last_observed_at", { ascending: false })
      .limit(30),
  ]);

  if (tracesResult.error) {
    throw new Error(`Could not load recent traces: ${tracesResult.error.message}`);
  }

  if (issuesResult.error) {
    throw new Error(`Could not load open issues: ${issuesResult.error.message}`);
  }

  return {
    health,
    recentTraces: (tracesResult.data ?? []) as DiagnosticTrace[],
    openIssues: (issuesResult.data ?? []) as DiagnosticIssue[],
  };
}
