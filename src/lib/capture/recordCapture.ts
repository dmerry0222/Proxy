import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { CaptureRequest } from "@/lib/capture/captureRequest";

/**
 * Writes a capture down, once.
 *
 * The single job of this module is that a capture becomes durable the moment
 * Proxy accepts it, before any interpretation is attempted. Everything
 * downstream -- classification, routing, execution items, Memory -- is
 * optional and may not exist yet; the record is not.
 *
 * Idempotency has two layers, because the fast path and the race need
 * different answers:
 *
 *   1. A lookup on (source, source_external_id) before inserting. This is the
 *      branch a Drafts retry or a double-tapped NFC tag hits.
 *   2. The partial unique index catching a concurrent insert that got past
 *      step 1. Two taps a few milliseconds apart both pass the lookup; the
 *      database decides, and the loser resolves to the winner's row instead
 *      of returning a 500 to a phone that will simply retry again.
 */

export type CaptureRecord = {
  id: string;
  source: string;
  captureType: string;
  sourceExternalId: string | null;
  capturedAt: string | null;
  receivedAt: string;
  processingStatus: string;
};

export type RecordCaptureResult =
  | { duplicate: false; capture: CaptureRecord }
  | { duplicate: true; reason: "source_external_id" | "concurrent_insert"; capture: CaptureRecord };

const CAPTURE_COLUMNS =
  "id, source, capture_type, source_external_id, captured_at, received_at, processing_status";

type CaptureRow = {
  id: string;
  source: string;
  capture_type: string;
  source_external_id: string | null;
  captured_at: string | null;
  received_at: string;
  processing_status: string;
};

function toRecord(row: CaptureRow): CaptureRecord {
  return {
    id: row.id,
    source: row.source,
    captureType: row.capture_type,
    sourceExternalId: row.source_external_id,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    processingStatus: row.processing_status,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value|unique constraint/i.test(message);
}

export async function findCaptureByExternalId(
  source: string,
  sourceExternalId: string
): Promise<CaptureRecord | null> {
  const { data, error } = await supabaseServer
    .from("captures")
    .select(CAPTURE_COLUMNS)
    .eq("source", source)
    .eq("source_external_id", sourceExternalId)
    .maybeSingle();

  if (error) throw new Error(`Could not check for an existing capture: ${error.message}`);
  return data ? toRecord(data as CaptureRow) : null;
}

export async function recordCapture(
  input: CaptureRequest,
  context: { traceId: string | null }
): Promise<RecordCaptureResult> {
  if (input.sourceExternalId) {
    const existing = await findCaptureByExternalId(input.source, input.sourceExternalId);
    if (existing) {
      return { duplicate: true, reason: "source_external_id", capture: existing };
    }
  }

  /*
   * metadata is stored as sent, with Proxy's own observations added under
   * keys the caller does not own. Merging rather than replacing means a
   * client can put anything it likes in there -- device, action name, GPS,
   * whatever a future Shortcut invents -- without Proxy having to know about
   * it in advance, which is the entire reason this is JSONB.
   */
  const metadata: Record<string, unknown> = {
    ...input.metadata,
    ...(input.captureTypeRecognized ? {} : { unrecognized_capture_type: input.captureType }),
    ...(input.capturedAtWarning ? { captured_at_warning: input.capturedAtWarning } : {}),
    ...(input.contentWarning ? { content_warning: input.contentWarning } : {}),
  };

  const payload = {
    source: input.source,
    capture_type: input.captureType,
    content: input.content,
    source_external_id: input.sourceExternalId,
    captured_at: input.capturedAt,
    processing_status: "received",
    diagnostic_trace_id: context.traceId,
    metadata,
  };

  try {
    const { data, error } = await supabaseServer
      .from("captures")
      .insert(payload)
      .select(CAPTURE_COLUMNS)
      .single();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("Capture insert returned no row.");

    return { duplicate: false, capture: toRecord(data as CaptureRow) };
  } catch (error) {
    if (input.sourceExternalId && isUniqueViolation(error)) {
      const existing = await findCaptureByExternalId(input.source, input.sourceExternalId);
      if (existing) {
        return { duplicate: true, reason: "concurrent_insert", capture: existing };
      }
    }
    throw error;
  }
}

/**
 * Moves a capture through received -> processing -> processed | failed.
 *
 * Provided now, with no processor calling it, on purpose: the lifecycle
 * contract is the deliverable. A future processor advances the status through
 * this function so the states stay consistent with what Inspector General and
 * the table comment both promise, instead of each processor inventing its own
 * spelling of "done".
 *
 * `content` is never touched here. A processed capture keeps its raw text
 * forever -- that is what makes it re-runnable when the processor improves.
 */
export async function setCaptureStatus(
  captureId: string,
  status: "processing" | "processed" | "failed",
  options?: { error?: string | null; metadata?: Record<string, unknown> }
): Promise<void> {
  const patch: Record<string, unknown> = {
    processing_status: status,
    updated_at: new Date().toISOString(),
  };

  if (status === "processed" || status === "failed") {
    patch.processed_at = new Date().toISOString();
  }
  if (status === "failed") {
    patch.processing_error = options?.error ?? "Unknown processing error";
  }
  if (status === "processing" || status === "processed") {
    // Clear a stale error from a previous attempt so the row never reads as
    // both processed and broken.
    patch.processing_error = null;
  }

  const { error } = await supabaseServer.from("captures").update(patch).eq("id", captureId);
  if (error) throw new Error(`Could not update capture status: ${error.message}`);
}
