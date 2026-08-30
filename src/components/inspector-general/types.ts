export type HealthState = "healthy" | "degraded" | "failing" | "stale" | "unknown";

export type HealthTile = {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
};

export type DiagnosticTraceRow = {
  id: string;
  module: string;
  source_type: string | null;
  source_id: string | null;
  object_type: string | null;
  object_id: string | null;
  summary: string;
  status: "in_progress" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
};

export type DiagnosticIssueRow = {
  id: string;
  trace_id: string | null;
  event_id: string | null;
  issue_type: string;
  severity: "info" | "warning" | "error" | "critical";
  status: "open" | "retrying" | "resolved_automatically" | "resolved_manually" | "ignored";
  human_summary: string;
  human_detail: string | null;
  object_type: string | null;
  object_id: string | null;
  source_type: string | null;
  source_id: string | null;
  first_observed_at: string;
  last_observed_at: string;
  attempt_count: number;
  retryable: boolean;
  technical_detail: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
};

export type DiagnosticEventRow = {
  id: string;
  trace_id: string;
  parent_event_id: string | null;
  module: string;
  stage: string;
  event_type: string;
  status: "success" | "failure" | "warning" | "pending";
  severity: "info" | "warning" | "error" | "critical";
  occurred_at: string;
  duration_ms: number | null;
  source_type: string | null;
  source_id: string | null;
  object_type: string | null;
  object_id: string | null;
  human_summary: string;
  human_detail: string | null;
  decision_type: string | null;
  decision_reason: string | null;
  technical_code: string | null;
  technical_detail: string | null;
  metadata: Record<string, unknown>;
};

export type InspectorGeneralOverview = {
  health: HealthTile[];
  recentTraces: DiagnosticTraceRow[];
  openIssues: DiagnosticIssueRow[];
};
