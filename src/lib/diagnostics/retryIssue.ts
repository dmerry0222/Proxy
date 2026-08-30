import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { resolveIssue } from "@/lib/diagnostics/emitEvent";
import { ingestEmailToMemory } from "@/lib/memory/ingestEmail";
import { syncExecuteToNotion } from "@/lib/notion/syncExecute";
import { getSurfaceMapping } from "@/lib/notion/mapping";
import type { DiagnosticIssue } from "@/lib/diagnostics/types";
import type { SurfaceObjectType } from "@/lib/notion/types";

export async function retryDiagnosticIssue(issueId: string): Promise<{ resolved: boolean; message: string }> {
  const { data: issue, error } = await supabaseServer
    .from("diagnostic_issues")
    .select("*")
    .eq("id", issueId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load issue: ${error.message}`);
  }

  const row = issue as DiagnosticIssue | null;

  if (!row) {
    throw new Error("Issue not found.");
  }

  if (!row.retryable) {
    throw new Error("This issue is not retryable.");
  }

  await supabaseServer
    .from("diagnostic_issues")
    .update({ status: "retrying", attempt_count: row.attempt_count + 1, updated_at: new Date().toISOString() })
    .eq("id", issueId);

  /*
   * Phase 1 only instrumented email → Memory; Notion surface-sync failures
   * were added later (Build: Turn On the Live Notion Execute Surface) and
   * are retried automatically by the periodic sweep anyway, but the manual
   * "Retry" button in Inspector General should also work rather than
   * silently doing nothing for this issue type. Extend this switch as more
   * sources gain diagnostic coverage.
   */
  if (row.issue_type === "notion_sync_failed" && row.object_type && row.object_id) {
    try {
      await syncExecuteToNotion({ dryRun: false, traceId: row.trace_id });
      const mapping = await getSurfaceMapping(row.object_type as SurfaceObjectType, row.object_id);
      if (mapping?.syncStatus === "synced") {
        await resolveIssue(issueId, { status: "resolved_automatically", resolutionNote: "Retry succeeded." });
        return { resolved: true, message: "Retry succeeded." };
      }
      return { resolved: false, message: "Retry ran but the object is still failing to sync; see its surface_objects error." };
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message : "Unknown error";
      return { resolved: false, message: `Retry failed: ${message}` };
    }
  }

  if (row.source_type !== "email" || !row.source_id) {
    return { resolved: false, message: `Retry is not yet supported for source type "${row.source_type}".` };
  }

  try {
    await ingestEmailToMemory(row.source_id);
    await resolveIssue(issueId, { status: "resolved_automatically", resolutionNote: "Retry succeeded." });
    return { resolved: true, message: "Retry succeeded." };
  } catch (retryError) {
    const message = retryError instanceof Error ? retryError.message : "Unknown error";
    await supabaseServer
      .from("diagnostic_issues")
      .update({
        status: "open",
        last_observed_at: new Date().toISOString(),
        technical_detail: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", issueId);
    return { resolved: false, message: `Retry failed: ${message}` };
  }
}
