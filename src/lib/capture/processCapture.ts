import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { claimReceivedCaptures, setCaptureStatus, type CaptureRecord } from "@/lib/capture/recordCapture";
import { recordExecutionEvidence } from "@/lib/reconciliation/evidence";
import { recordOrUpdateIssue, resolveIssueByDedupKey } from "@/lib/diagnostics/emitEvent";

/**
 * Priority 2: the processor the capture front door was built ahead of (see
 * the PROVENANCE CONTRACT comment in 20260902121129_capture_front_door.sql
 * and setCaptureStatus's doc comment). Runs against rows already atomically
 * claimed into 'processing' by claimReceivedCaptures -- this module never
 * loads a 'received' row itself, so it never needs its own race guard.
 */

const CHECKBOX_LINE = /^[-*]\s*\[([ xX])\]\s*(.*)$/;
const HEADING_LINE = /^#{1,6}\s*(.*)$/;

export type CaptureOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "task"; executionItemId: string; created: boolean }
  | { kind: "memory"; memorySourceId: string }
  | { kind: "failed"; error: string };

/**
 * Expected misfires (blank, bare checkbox marker, heading with nothing
 * after it) are not infrastructure failures -- see captures_processing_status_check.
 * Detected by stripping the one layer of Markdown structure a capture might
 * carry and checking whether any actual content remains underneath it.
 */
function misfireReason(content: string): string | null {
  const stripped = content.trim();
  if (stripped.length === 0) return "empty_or_misfire";

  const withoutCheckbox = stripped.replace(CHECKBOX_LINE, (_, __, rest) => rest);
  const withoutHeading = withoutCheckbox.replace(HEADING_LINE, (_, rest) => rest);

  if (withoutHeading.trim().length === 0) return "empty_or_misfire";
  return null;
}

function checkboxState(content: string): "complete" | "incomplete" | null {
  const match = content.trim().match(CHECKBOX_LINE);
  if (!match) return null;
  return match[1].toLowerCase() === "x" ? "complete" : "incomplete";
}

function taskTitle(content: string): string {
  const checkbox = content.trim().match(CHECKBOX_LINE);
  const withoutCheckbox = checkbox ? checkbox[2] : content.trim();
  // HEADING_LINE has no multiline flag, so it only strips a heading marker
  // that spans the whole (single-line) string -- apply it per-line instead
  // so a heading followed by more lines (e.g. a multi-task capture) still
  // gets its leading "#" stripped from the title.
  const lines = withoutCheckbox.split("\n").map((line) => line.replace(HEADING_LINE, (_, rest) => rest).trim());
  const firstLine = lines.find((line) => line.length > 0) ?? "";
  return (firstLine || withoutCheckbox.trim() || content.trim()).slice(0, 500);
}

function isTaskShaped(capture: CaptureRecord): boolean {
  if (capture.captureType === "quick_add_task") return true;
  if (checkboxState(capture.content) !== null) return true;
  return capture.captureType === "quick_add";
}

function isMemoryShaped(capture: CaptureRecord): boolean {
  return capture.captureType === "long_ramble" || capture.captureType === "note" || capture.captureType === "idea" || capture.captureType === "log";
}

/**
 * quick_add_task captures -> execution_items, one per capture, idempotent
 * via the existing unique index on (source_system, source_ref) -- mirrors
 * the insert shape mailroomIntake.ts uses for its own source_system.
 * Respects a Markdown checkbox's completed/incomplete state when present.
 */
async function createTaskFromCapture(capture: CaptureRecord): Promise<CaptureOutcome> {
  const state = checkboxState(capture.content);
  const status = state === "complete" ? "completed" : "candidate";

  const { data, error } = await supabaseServer.rpc("upsert_capture_execution_item", {
    p_capture_id: capture.id,
    p_title: taskTitle(capture.content),
    p_status: status,
    p_why_surfaced: `Captured via ${capture.source}${capture.captureType ? ` (${capture.captureType})` : ""}.`,
    p_metadata: { capture_source: capture.source, capture_type: capture.captureType },
  });

  if (error) throw new Error(`Could not create execution item from capture: ${error.message}`);
  const row = (data as Array<{ item_id: string; was_created: boolean }> | null)?.[0];
  if (!row) throw new Error("upsert_capture_execution_item returned no row.");

  const executionItemId = row.item_id;
  const created = row.was_created;

  await recordExecutionEvidence({
    executionItemId,
    sourceType: "capture",
    sourceLocator: { capture_id: capture.id },
    relationship: "supports_creation",
    excerpt: capture.content.slice(0, 2000),
    occurredAt: capture.capturedAt ?? capture.receivedAt,
    metadata: { source: capture.source, capture_type: capture.captureType },
  });

  return { kind: "task", executionItemId, created };
}

/**
 * Long-form/ramble captures -> one memory_sources row, not per-sentence task
 * extraction. Find-or-create by (canonical_table, canonical_record_id),
 * matching calendarEventSource.ts's pattern since memory_sources has no DB
 * unique constraint of its own to upsert against.
 */
async function createMemorySourceFromCapture(capture: CaptureRecord): Promise<CaptureOutcome> {
  const { data: existing, error: lookupError } = await supabaseServer
    .from("memory_sources")
    .select("id")
    .eq("canonical_table", "captures")
    .eq("canonical_record_id", capture.id)
    .maybeSingle();

  if (lookupError) throw new Error(`Could not check for existing memory source: ${lookupError.message}`);

  if (existing) {
    await supabaseServer.from("captures").update({ memory_source_id: existing.id }).eq("id", capture.id);
    return { kind: "memory", memorySourceId: existing.id as string };
  }

  const firstLine = capture.content.trim().split("\n")[0].trim();
  const { data: inserted, error } = await supabaseServer
    .from("memory_sources")
    .insert({
      source_type: "user_statement",
      title: firstLine.slice(0, 200) || "Capture",
      canonical_table: "captures",
      canonical_record_id: capture.id,
      content_text: capture.content,
      source_at: capture.capturedAt ?? capture.receivedAt,
      metadata: { source: capture.source, capture_type: capture.captureType },
    })
    .select("id")
    .single();

  if (error || !inserted) throw new Error(`Could not create memory source from capture: ${error?.message ?? "unknown error"}`);

  await supabaseServer.from("captures").update({ memory_source_id: inserted.id }).eq("id", capture.id);
  return { kind: "memory", memorySourceId: inserted.id as string };
}

export async function processCapture(capture: CaptureRecord): Promise<CaptureOutcome> {
  const misfire = misfireReason(capture.content);
  if (misfire) {
    await setCaptureStatus(capture.id, "ignored", { error: misfire });
    return { kind: "ignored", reason: misfire };
  }

  try {
    const outcome = isTaskShaped(capture)
      ? await createTaskFromCapture(capture)
      : isMemoryShaped(capture)
        ? await createMemorySourceFromCapture(capture)
        // Unrecognized capture_type, not task- or checkbox-shaped: preserved as
        // durable evidence via the row itself; default to a Memory source so it
        // is at least queryable rather than silently stuck at 'processing'.
        : await createMemorySourceFromCapture(capture);

    await setCaptureStatus(capture.id, "processed");
    await resolveIssueByDedupKey(`capture_processing_failed:${capture.id}`, "A subsequent processing attempt for this capture succeeded.");
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown capture processing error";
    await setCaptureStatus(capture.id, "failed", { error: message });
    await recordOrUpdateIssue(`capture_processing_failed:${capture.id}`, {
      issueType: "capture_processing_failed",
      severity: "error",
      humanSummary: `Could not process capture ${capture.id}.`,
      technicalDetail: message,
      objectType: "capture",
      objectId: capture.id,
      sourceType: "capture",
      sourceId: capture.id,
      retryable: true,
    });
    return { kind: "failed", error: message };
  }
}

export type ProcessCaptureBatchSummary = {
  claimed: number;
  processed: number;
  ignored: number;
  failed: number;
};

export async function processReceivedCaptures(limit = 25): Promise<ProcessCaptureBatchSummary> {
  const claimed = await claimReceivedCaptures(limit);

  const summary: ProcessCaptureBatchSummary = { claimed: claimed.length, processed: 0, ignored: 0, failed: 0 };

  for (const capture of claimed) {
    const outcome = await processCapture(capture);
    if (outcome.kind === "ignored") summary.ignored += 1;
    else if (outcome.kind === "failed") summary.failed += 1;
    else summary.processed += 1;
  }

  return summary;
}
