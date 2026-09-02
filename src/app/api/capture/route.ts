import { NextResponse } from "next/server";

import { CaptureAuthError, requireCaptureSecret } from "@/lib/auth/captureAuth";
import { capturePreview, validateCaptureRequest } from "@/lib/capture/captureRequest";
import { recordCapture } from "@/lib/capture/recordCapture";
import { completeTrace, emitDiagnosticEvent, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";

export const runtime = "nodejs";

/**
 * POST /api/capture -- the general front door for intentional user captures.
 *
 * One endpoint for Drafts, iOS Shortcuts, the Proxy UI, Share Sheet actions,
 * NFC automations, and whatever comes next. Not one route per client: the
 * clients differ only in which strings they put in `source` and `metadata`,
 * and a route per device would mean six copies of this auth-validate-record-
 * observe sequence drifting apart.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not classify, route, or
 * interpret. A capture is written down and acknowledged; deciding what
 * "Email Alicia about the revised internship form" should become is a
 * separate concern with a separate failure mode, and coupling them would mean
 * a classifier outage loses the thought. The lifecycle columns and the
 * status-transition helper exist so that processor can be added later without
 * touching this route or the contract Drafts is written against.
 *
 * Structured after /api/ingestion/artifacts/external, which solved the same
 * problem (public endpoint, shared secret, retrying client, needs provenance)
 * for machine-to-machine traffic.
 */
export async function POST(request: Request) {
  /*
   * Authenticate BEFORE opening a trace. This endpoint is publicly reachable
   * on Vercel, so unauthenticated probes are expected background noise --
   * opening a trace per probe would let anyone inflate the diagnostics
   * tables. Rejections are still recorded, as issues rather than traces.
   */
  try {
    requireCaptureSecret(request);
  } catch (error) {
    if (error instanceof CaptureAuthError) {
      if (error.presented) {
        // A wrong-but-present secret is a real signal: a rotated secret, a
        // stale Shortcut, or someone guessing. A missing one usually is not.
        await recordIssue({
          issueType: "capture_rejected",
          severity: "warning",
          humanSummary: "Capture rejected an invalid credential",
          sourceType: "capture",
          retryable: false,
          technicalDetail: error.message,
        });
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const validation = validateCaptureRequest(body);
  if (!validation.ok) {
    /*
     * A rejected capture is a lost thought, so it is recorded as an issue
     * even though nothing failed on Proxy's side: the useful signal is "a
     * client Dave built is sending something this endpoint won't take", and
     * that is only discoverable if the rejection is written down somewhere he
     * looks. The body itself is not stored -- it may be personal, and the
     * rejection reason is what makes the client fixable.
     */
    await recordIssue({
      issueType: "capture_invalid_payload",
      severity: "warning",
      humanSummary: "Capture rejected a malformed payload",
      sourceType: "capture",
      retryable: false,
      technicalDetail: validation.error,
    });
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  const input = validation.value;
  const preview = capturePreview(input.content);

  /*
   * Warnings are things Proxy fixed rather than failed on. They travel in the
   * response so a client author can see them, and become diagnostic events so
   * they are still discoverable months later when nobody is watching a
   * console.
   */
  const warnings = [input.capturedAtWarning, input.contentWarning].filter(
    (value): value is string => Boolean(value)
  );

  const traceId = await startTrace({
    module: "capture",
    sourceType: "capture",
    sourceId: input.sourceExternalId,
    summary: `${input.source} → ${input.captureType}: ${preview}`,
    metadata: {
      source: input.source,
      capture_type: input.captureType,
      capture_type_recognized: input.captureTypeRecognized,
      source_external_id: input.sourceExternalId,
      captured_at: input.capturedAt,
      content_length: input.content.length,
      // metadata.action is descriptive provenance, not a controlled value --
      // it is surfaced here so Inspector General can show which Drafts action
      // or Shortcut produced this without opening the capture row.
      action: typeof input.metadata.action === "string" ? input.metadata.action : null,
    },
  });

  try {
    const result = await recordCapture(input, { traceId });
    const capture = result.capture;

    /*
     * Every event carries objectType "capture" + the capture id. That is what
     * makes the record navigable in Inspector General from the object side
     * (loadTraceIdForObject matches on object_type + object_id), so the
     * provenance chain reads as "Drafts → quick_add_task → received → ..."
     * from either end.
     */
    if (result.duplicate) {
      await emitDiagnosticEvent({
        traceId,
        module: "capture",
        stage: "intake",
        eventType: "capture_duplicate",
        status: "success",
        objectType: "capture",
        objectId: capture.id,
        humanSummary: `Already captured from ${capture.source} (${result.reason === "concurrent_insert" ? "concurrent retry" : "same source id"})`,
        decisionType: "duplicate_skipped",
        decisionReason: result.reason,
        metadata: {
          source_external_id: capture.sourceExternalId,
          first_received_at: capture.receivedAt,
          processing_status: capture.processingStatus,
        },
      });
      await completeTrace(traceId, {
        status: "completed",
        summary: `Duplicate capture: ${preview}`,
      });

      /*
       * 200, not 409. The caller did nothing wrong -- a retry that lands on
       * the same capture is the system working -- and a Drafts action that
       * sees an error status will keep retrying, which is precisely the loop
       * this response is meant to close.
       */
      return NextResponse.json({
        success: true,
        duplicate: true,
        duplicateReason: result.reason,
        captureId: capture.id,
        source: capture.source,
        captureType: capture.captureType,
        processingStatus: capture.processingStatus,
        receivedAt: capture.receivedAt,
        traceId,
      });
    }

    await emitDiagnosticEvent({
      traceId,
      module: "capture",
      stage: "intake",
      eventType: "capture_received",
      status: "success",
      objectType: "capture",
      objectId: capture.id,
      humanSummary: `Captured from ${capture.source} as ${capture.captureType}: ${preview}`,
      metadata: {
        capture_id: capture.id,
        source: capture.source,
        capture_type: capture.captureType,
        capture_type_recognized: input.captureTypeRecognized,
        source_external_id: capture.sourceExternalId,
        content_length: input.content.length,
        captured_at: capture.capturedAt,
        received_at: capture.receivedAt,
      },
    });

    /*
     * An unrecognized capture_type is worth SEEING without being worth
     * failing: it is how the vocabulary grows, and the warning event is the
     * only place it would otherwise show up.
     */
    if (!input.captureTypeRecognized) {
      await emitDiagnosticEvent({
        traceId,
        module: "capture",
        stage: "intake",
        eventType: "capture_type_unrecognized",
        status: "warning",
        severity: "info",
        objectType: "capture",
        objectId: capture.id,
        humanSummary: `Capture type "${capture.captureType}" is not one Proxy recognizes yet; it was recorded as sent.`,
        metadata: { capture_type: capture.captureType },
      });
    }

    for (const warning of warnings) {
      await emitDiagnosticEvent({
        traceId,
        module: "capture",
        stage: "intake",
        eventType: "capture_accepted_with_warning",
        status: "warning",
        severity: "info",
        objectType: "capture",
        objectId: capture.id,
        humanSummary: warning,
      });
    }

    /*
     * The trace completes at "received" because that IS the finished state
     * for this endpoint today. Leaving it in_progress to await a processor
     * that does not exist would make every healthy capture look stuck, and
     * would make the first real failure invisible among them.
     */
    await completeTrace(traceId, {
      status: "completed",
      summary: `${capture.source} → ${capture.captureType} → received: ${preview}`,
    });

    return NextResponse.json(
      {
        success: true,
        duplicate: false,
        captureId: capture.id,
        source: capture.source,
        captureType: capture.captureType,
        captureTypeRecognized: input.captureTypeRecognized,
        processingStatus: capture.processingStatus,
        capturedAt: capture.capturedAt,
        receivedAt: capture.receivedAt,
        ...(warnings.length ? { warnings } : {}),
        traceId,
      },
      { status: 201 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown capture error";
    console.error("Capture failed:", error);

    await emitDiagnosticEvent({
      traceId,
      module: "capture",
      stage: "intake",
      eventType: "capture_failed",
      status: "failure",
      severity: "error",
      objectType: "capture",
      objectId: input.sourceExternalId,
      humanSummary: `Failed to record a ${input.captureType} capture from ${input.source}`,
      technicalDetail: message,
      metadata: {
        source: input.source,
        capture_type: input.captureType,
        source_external_id: input.sourceExternalId,
        content_length: input.content.length,
      },
    });
    await recordIssue({
      traceId,
      issueType: "capture_failed",
      severity: "error",
      humanSummary: `Capture failed from ${input.source} (${input.captureType})`,
      sourceType: "capture",
      sourceId: input.sourceExternalId,
      retryable: true,
      technicalDetail: message,
    });
    await completeTrace(traceId, { status: "failed", summary: `${input.source} → ${input.captureType} → failed: ${message}` });

    /*
     * 500 so the client retries. The capture is still in the caller's hands
     * at this point -- the draft is still in Drafts, the note still on the
     * phone -- and a retry is the only thing that can still save it.
     */
    return NextResponse.json({ success: false, error: message, traceId }, { status: 500 });
  }
}
