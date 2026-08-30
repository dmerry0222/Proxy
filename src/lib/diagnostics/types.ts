export type TraceStatus = "in_progress" | "completed" | "failed";

export type EventStatus = "success" | "failure" | "warning" | "pending";

export type Severity = "info" | "warning" | "error" | "critical";

export type IssueStatus =
  | "open"
  | "retrying"
  | "resolved_automatically"
  | "resolved_manually"
  | "ignored";

export type DiagnosticTrace = {
  id: string;
  module: string;
  source_type: string | null;
  source_id: string | null;
  object_type: string | null;
  object_id: string | null;
  summary: string;
  status: TraceStatus;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DiagnosticEvent = {
  id: string;
  trace_id: string;
  parent_event_id: string | null;
  module: string;
  stage: string;
  event_type: string;
  status: EventStatus;
  severity: Severity;
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
  created_at: string;
};

export type DiagnosticIssue = {
  id: string;
  trace_id: string | null;
  event_id: string | null;
  issue_type: string;
  severity: Severity;
  status: IssueStatus;
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
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};
