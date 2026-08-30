"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Radar, CheckCircle2, AlertTriangle, XCircle, HelpCircle, Clock3, RotateCw } from "lucide-react";

import TraceDrawer from "@/components/inspector-general/TraceDrawer";
import type {
  DiagnosticIssueRow,
  HealthState,
  HealthTile,
  InspectorGeneralOverview,
} from "@/components/inspector-general/types";

type Tab = "health" | "attention" | "activity";

function healthStyles(state: HealthState) {
  switch (state) {
    case "healthy":
      return { text: "text-emerald-300", bg: "bg-emerald-950/40 border-emerald-900/50", Icon: CheckCircle2 };
    case "degraded":
      return { text: "text-amber-300", bg: "bg-amber-950/40 border-amber-900/50", Icon: AlertTriangle };
    case "failing":
      return { text: "text-red-300", bg: "bg-red-950/40 border-red-900/50", Icon: XCircle };
    case "stale":
      return { text: "text-amber-300", bg: "bg-amber-950/40 border-amber-900/50", Icon: Clock3 };
    case "unknown":
      return { text: "text-neutral-400", bg: "bg-neutral-900 border-neutral-800", Icon: HelpCircle };
  }
}

function severityBadge(severity: DiagnosticIssueRow["severity"]) {
  switch (severity) {
    case "critical":
    case "error":
      return "text-red-300 bg-red-950/40 border-red-900/50";
    case "warning":
      return "text-amber-300 bg-amber-950/40 border-amber-900/50";
    case "info":
      return "text-blue-300 bg-blue-950/30 border-blue-900/50";
  }
}

function HealthGrid({ health }: { health: HealthTile[] }) {
  if (health.length === 0) {
    return <div className="text-sm text-neutral-500">No modules are registered for health monitoring yet.</div>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {health.map((tile) => {
        const { text, bg, Icon } = healthStyles(tile.state);

        return (
          <div key={tile.key} className={`rounded-xl border p-4 ${bg}`}>
            <div className={`flex items-center gap-2 text-sm font-medium ${text}`}>
              <Icon className="h-4 w-4" />
              {tile.label}
            </div>
            <div className="mt-1 text-xs text-neutral-500">{tile.detail}</div>
          </div>
        );
      })}
    </div>
  );
}

function IssuesList({
  issues,
  onInspect,
  onRetried,
}: {
  issues: DiagnosticIssueRow[];
  onInspect: (traceId: string) => void;
  onRetried: (issueId: string) => void;
}) {
  const [retrying, setRetrying] = useState<string | null>(null);

  if (issues.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
        Nothing needs attention right now.
      </div>
    );
  }

  async function retry(issueId: string) {
    setRetrying(issueId);

    try {
      const response = await fetch(`/api/inspector-general/issues/${issueId}/retry`, { method: "POST" });
      const data = await response.json();

      if (data.success && data.result?.resolved) {
        onRetried(issueId);
      }
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="space-y-2">
      {issues.map((issue) => (
        <div key={issue.id} className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${severityBadge(issue.severity)}`}>
                {issue.issue_type.replace(/_/g, " ")}
              </span>
              <div className="mt-1.5 text-sm text-neutral-200">{issue.human_summary}</div>
              {issue.human_detail && <div className="mt-1 text-xs text-neutral-500">{issue.human_detail}</div>}
              <div className="mt-2 text-xs text-neutral-600">
                First seen {new Date(issue.first_observed_at).toLocaleString()} · {issue.attempt_count} attempt
                {issue.attempt_count === 1 ? "" : "s"}
              </div>
            </div>

            <div className="flex shrink-0 gap-2">
              {issue.trace_id && (
                <button
                  onClick={() => onInspect(issue.trace_id!)}
                  className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
                >
                  Inspect
                </button>
              )}
              {issue.retryable && (
                <button
                  onClick={() => retry(issue.id)}
                  disabled={retrying === issue.id}
                  className="flex items-center gap-1 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
                >
                  <RotateCw className={`h-3 w-3 ${retrying === issue.id ? "animate-spin" : ""}`} />
                  Retry
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  traces,
  onInspect,
}: {
  traces: InspectorGeneralOverview["recentTraces"];
  onInspect: (traceId: string) => void;
}) {
  if (traces.length === 0) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-950 p-6 text-center text-sm text-neutral-500">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {traces.map((trace) => {
        const statusColor =
          trace.status === "completed"
            ? "text-emerald-400"
            : trace.status === "failed"
              ? "text-red-400"
              : "text-neutral-500";

        return (
          <button
            key={trace.id}
            onClick={() => onInspect(trace.id)}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-left hover:bg-neutral-900"
          >
            <div>
              <div className="text-sm text-neutral-200">{trace.summary}</div>
              <div className="mt-1 text-xs text-neutral-600">
                {trace.module}
                {trace.source_type ? ` · ${trace.source_type}` : ""} · {new Date(trace.started_at).toLocaleString()}
              </div>
            </div>

            <span className={`text-xs font-medium ${statusColor}`}>{trace.status.replace("_", " ")}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function InspectorGeneralDashboard({
  initialOverview,
}: {
  initialOverview: InspectorGeneralOverview;
}) {
  const searchParams = useSearchParams();
  const [overview, setOverview] = useState(initialOverview);
  const [tab, setTab] = useState<Tab>("health");
  const [openTraceId, setOpenTraceId] = useState<string | null>(searchParams.get("traceId"));

  useEffect(() => {
    const objectType = searchParams.get("objectType");
    const objectId = searchParams.get("objectId");

    if (!objectType || !objectId) return;

    fetch(`/api/inspector-general/object-trace?objectType=${objectType}&objectId=${objectId}`)
      .then((response) => response.json())
      .then((data) => {
        if (data.success && data.result?.traceId) {
          setOpenTraceId(data.result.traceId);
        }
      })
      .catch(() => {});
  }, [searchParams]);

  async function refresh() {
    const response = await fetch("/api/inspector-general/overview");
    const data = await response.json();

    if (data.success) {
      setOverview(data.result);
    }
  }

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: "health", label: "System Health" },
    { key: "attention", label: "Needs Attention", count: overview.openIssues.length },
    { key: "activity", label: "Recent Activity" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <header>
        <div className="flex items-center gap-2 text-sm text-neutral-500">
          <Radar className="h-4 w-4" />
          Oversight &amp; Diagnostics
        </div>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Inspector General</h1>
        <p className="mt-1 text-sm text-neutral-500">
          What Proxy saw, what it understood, what it decided, and whether anything went wrong.
        </p>
      </header>

      <div className="flex gap-1 border-b border-neutral-800">
        {tabs.map((item) => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={[
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition",
              tab === item.key
                ? "border-neutral-100 text-neutral-100"
                : "border-transparent text-neutral-500 hover:text-neutral-300",
            ].join(" ")}
          >
            {item.label}
            {typeof item.count === "number" && item.count > 0 && (
              <span className="rounded-full bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-300">{item.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "health" && <HealthGrid health={overview.health} />}

      {tab === "attention" && (
        <IssuesList
          issues={overview.openIssues}
          onInspect={setOpenTraceId}
          onRetried={() => refresh()}
        />
      )}

      {tab === "activity" && <ActivityFeed traces={overview.recentTraces} onInspect={setOpenTraceId} />}

      {openTraceId && <TraceDrawer key={openTraceId} traceId={openTraceId} onClose={() => setOpenTraceId(null)} />}
    </div>
  );
}
