import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { EventStatus, IssueStatus, Severity } from "@/lib/diagnostics/types";

/*
 * Diagnostics must never break the pipeline they observe. Every function
 * here swallows its own Supabase errors (logging to console.error) rather
 * than throwing, so a failed diagnostic write can't fail an ingestion run.
 */

export async function startTrace(input: {
  module: string;
  sourceType?: string | null;
  sourceId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer
      .from("diagnostic_traces")
      .insert({
        module: input.module,
        source_type: input.sourceType ?? null,
        source_id: input.sourceId ?? null,
        object_type: input.objectType ?? null,
        object_id: input.objectId ?? null,
        summary: input.summary,
        status: "in_progress",
        metadata: input.metadata ?? {},
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Could not start diagnostic trace:", error?.message);
      return null;
    }

    return data.id as string;
  } catch (error) {
    console.error("Could not start diagnostic trace:", error);
    return null;
  }
}

export async function completeTrace(
  traceId: string | null,
  input: { status: "completed" | "failed"; summary?: string }
): Promise<void> {
  if (!traceId) return;

  try {
    const { error } = await supabaseServer
      .from("diagnostic_traces")
      .update({
        status: input.status,
        completed_at: new Date().toISOString(),
        ...(input.summary ? { summary: input.summary } : {}),
      })
      .eq("id", traceId);

    if (error) {
      console.error("Could not complete diagnostic trace:", error.message);
    }
  } catch (error) {
    console.error("Could not complete diagnostic trace:", error);
  }
}

export async function emitDiagnosticEvent(input: {
  traceId: string | null;
  parentEventId?: string | null;
  module: string;
  stage: string;
  eventType: string;
  status: EventStatus;
  severity?: Severity;
  sourceType?: string | null;
  sourceId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  humanSummary: string;
  humanDetail?: string | null;
  decisionType?: string | null;
  decisionReason?: string | null;
  technicalCode?: string | null;
  technicalDetail?: string | null;
  metadata?: Record<string, unknown>;
  durationMs?: number | null;
}): Promise<string | null> {
  if (!input.traceId) return null;

  try {
    const { data, error } = await supabaseServer
      .from("diagnostic_events")
      .insert({
        trace_id: input.traceId,
        parent_event_id: input.parentEventId ?? null,
        module: input.module,
        stage: input.stage,
        event_type: input.eventType,
        status: input.status,
        severity: input.severity ?? "info",
        source_type: input.sourceType ?? null,
        source_id: input.sourceId ?? null,
        object_type: input.objectType ?? null,
        object_id: input.objectId ?? null,
        human_summary: input.humanSummary,
        human_detail: input.humanDetail ?? null,
        decision_type: input.decisionType ?? null,
        decision_reason: input.decisionReason ?? null,
        technical_code: input.technicalCode ?? null,
        technical_detail: input.technicalDetail ?? null,
        metadata: input.metadata ?? {},
        duration_ms: input.durationMs ?? null,
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Could not emit diagnostic event:", error?.message);
      return null;
    }

    return data.id as string;
  } catch (error) {
    console.error("Could not emit diagnostic event:", error);
    return null;
  }
}

export async function recordIssue(input: {
  traceId?: string | null;
  eventId?: string | null;
  issueType: string;
  severity: Severity;
  humanSummary: string;
  humanDetail?: string | null;
  objectType?: string | null;
  objectId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  retryable: boolean;
  technicalDetail?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer
      .from("diagnostic_issues")
      .insert({
        trace_id: input.traceId ?? null,
        event_id: input.eventId ?? null,
        issue_type: input.issueType,
        severity: input.severity,
        status: "open",
        human_summary: input.humanSummary,
        human_detail: input.humanDetail ?? null,
        object_type: input.objectType ?? null,
        object_id: input.objectId ?? null,
        source_type: input.sourceType ?? null,
        source_id: input.sourceId ?? null,
        retryable: input.retryable,
        technical_detail: input.technicalDetail ?? null,
        metadata: input.metadata ?? {},
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("Could not record diagnostic issue:", error?.message);
      return null;
    }

    return data.id as string;
  } catch (error) {
    console.error("Could not record diagnostic issue:", error);
    return null;
  }
}

export async function resolveIssue(
  issueId: string,
  input: { status: IssueStatus; resolutionNote?: string }
): Promise<void> {
  try {
    const { error } = await supabaseServer
      .from("diagnostic_issues")
      .update({
        status: input.status,
        resolution_note: input.resolutionNote ?? null,
        resolved_at: input.status.startsWith("resolved") ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", issueId);

    if (error) {
      console.error("Could not resolve diagnostic issue:", error.message);
    }
  } catch (error) {
    console.error("Could not resolve diagnostic issue:", error);
  }
}
