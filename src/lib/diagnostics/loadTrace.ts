import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { DiagnosticEvent, DiagnosticTrace } from "@/lib/diagnostics/types";

export type TraceDetail = {
  trace: DiagnosticTrace;
  events: DiagnosticEvent[];
};

export async function loadTraceDetail(traceId: string): Promise<TraceDetail | null> {
  const [traceResult, eventsResult] = await Promise.all([
    supabaseServer.from("diagnostic_traces").select("*").eq("id", traceId).maybeSingle(),
    supabaseServer
      .from("diagnostic_events")
      .select("*")
      .eq("trace_id", traceId)
      .order("occurred_at", { ascending: true }),
  ]);

  if (traceResult.error) {
    throw new Error(`Could not load trace: ${traceResult.error.message}`);
  }

  if (!traceResult.data) {
    return null;
  }

  if (eventsResult.error) {
    throw new Error(`Could not load trace events: ${eventsResult.error.message}`);
  }

  return {
    trace: traceResult.data as DiagnosticTrace,
    events: (eventsResult.data ?? []) as DiagnosticEvent[],
  };
}
