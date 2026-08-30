import { NextResponse } from "next/server";

import { IngestionAuthError, requireIngestionSecret } from "@/lib/auth/ingestionAuth";
import { completeTrace, emitDiagnosticEvent, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { ingestArtifact } from "@/lib/ingestion/ingestArtifact";
import {
  decodeBase64Content,
  externalArtifactIdentity,
  validateExternalArtifactRequest,
} from "@/lib/ingestion/externalArtifactRequest";
import type { ArtifactContextHint, ArtifactType } from "@/lib/ingestion/types";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Trusted machine-to-machine artifact ingestion, for Power Automate pushing
 * Outlook meeting-note attachments.
 *
 * Deliberately a SEPARATE route from the manual upload at
 * /api/ingestion/artifacts rather than a mode of it. The two have different
 * trust models (shared secret vs. an authenticated human at a browser),
 * different transports (JSON+base64 vs. multipart form), and different
 * idempotency needs (a cloud flow retries; a person does not). Folding them
 * together would mean the manual path grew an auth bypass and the machine
 * path inherited form parsing -- so the manual route is untouched, and the
 * only thing shared is ingestArtifact() itself.
 */

/**
 * Fast-path idempotency: has this exact (message, attachment) already been
 * ingested? Relies on the pre-existing UNIQUE (source_system, external_id,
 * version) constraint on artifacts, which also backstops the race below.
 */
async function findExistingByIdentity(sourceSystem: string, externalId: string) {
  const { data, error } = await supabaseServer
    .from("artifacts")
    .select("id, memory_source_id, content_kind, created_at")
    .eq("source_system", sourceSystem)
    .eq("external_id", externalId)
    .maybeSingle();

  if (error) throw new Error(`Could not check for an existing artifact: ${error.message}`);
  return data;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate key value|unique constraint/i.test(message);
}

export async function POST(request: Request) {
  /*
   * Authenticate BEFORE opening a trace. This endpoint is publicly
   * reachable on Vercel, so unauthenticated probes are expected background
   * noise -- opening a trace per probe would let anyone inflate the
   * diagnostics tables. Rejections are still recorded, just as issues
   * rather than traces (recordIssue does not require a trace).
   */
  try {
    requireIngestionSecret(request);
  } catch (error) {
    if (error instanceof IngestionAuthError) {
      if (error.presented) {
        // A wrong-but-present secret is a real signal: a rotated secret, a
        // stale flow, or someone guessing. A missing one usually is not.
        await recordIssue({
          issueType: "external_ingestion_rejected",
          severity: "warning",
          humanSummary: "External artifact ingestion rejected an invalid credential",
          sourceType: "external_ingestion",
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
    return NextResponse.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
  }

  const validation = validateExternalArtifactRequest(body);
  if (!validation.ok) {
    await recordIssue({
      issueType: "external_ingestion_invalid_payload",
      severity: "warning",
      humanSummary: "External artifact ingestion rejected a malformed payload",
      sourceType: "external_ingestion",
      retryable: false,
      technicalDetail: validation.error,
    });
    return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
  }

  const input = validation.value;
  const externalId = externalArtifactIdentity(input);

  const traceId = await startTrace({
    module: "ingestion",
    sourceType: "external_ingestion",
    sourceId: externalId,
    summary: `External artifact ingestion: ${input.filename}`,
    metadata: {
      source_system: input.sourceSystem,
      artifact_type: input.artifactType,
      context_hint: input.contextHint,
      outlook_message_id: input.outlookMessageId,
      internet_message_id: input.internetMessageId,
      attachment_id: input.attachmentId,
      idempotency_key: externalId,
    },
  });

  /*
   * Emit against the EMAIL identity as well as the artifact, so Inspector
   * General can enter this trace from either end of the chain
   * (loadTraceIdForObject matches on object_type + object_id). This is what
   * makes "Outlook email -> attachment -> artifact -> Memory" navigable
   * rather than merely recorded.
   */
  const emailObjectId = input.internetMessageId ?? input.outlookMessageId;

  await emitDiagnosticEvent({
    traceId,
    module: "ingestion",
    stage: "external_intake",
    eventType: "ingestion_accepted",
    status: "success",
    objectType: emailObjectId ? "email" : null,
    objectId: emailObjectId,
    humanSummary: `Accepted "${input.filename}" from ${input.sourceSystem}${input.emailSubject ? ` (email: ${input.emailSubject})` : ""}`,
    metadata: {
      filename: input.filename,
      mime_type: input.mimeType,
      sender: input.sender,
      email_subject: input.emailSubject,
      idempotency_key: externalId,
    },
  });

  try {
    const decoded = decodeBase64Content(input.contentBase64);
    if (!decoded.ok) {
      await emitDiagnosticEvent({
        traceId,
        module: "ingestion",
        stage: "external_intake",
        eventType: "ingestion_rejected",
        status: "failure",
        severity: "warning",
        objectType: emailObjectId ? "email" : null,
        objectId: emailObjectId,
        humanSummary: `Rejected "${input.filename}": ${decoded.error}`,
        technicalDetail: decoded.error,
      });
      await completeTrace(traceId, { status: "failed", summary: decoded.error });
      return NextResponse.json({ success: false, error: decoded.error }, { status: /limit is/.test(decoded.error) ? 413 : 400 });
    }

    // Fast-path duplicate: skip storage upload and all downstream LLM
    // processing entirely. This is the branch a Power Automate retry hits.
    if (externalId) {
      const existing = await findExistingByIdentity(input.sourceSystem, externalId);
      if (existing) {
        await emitDiagnosticEvent({
          traceId,
          module: "ingestion",
          stage: "external_intake",
          eventType: "ingestion_duplicate",
          status: "success",
          objectType: "artifact",
          objectId: existing.id,
          humanSummary: `Already ingested "${input.filename}" (matched on message + attachment id)`,
          decisionType: "duplicate_skipped",
          decisionReason: "idempotency_key",
          metadata: { idempotency_key: externalId, first_ingested_at: existing.created_at },
        });
        await completeTrace(traceId, { status: "completed", summary: "Duplicate: already ingested" });
        return NextResponse.json({
          success: true,
          duplicate: true,
          duplicateReason: "idempotency_key",
          artifactId: existing.id,
          sourceId: existing.memory_source_id,
          contentKind: existing.content_kind,
          idempotencyKey: externalId,
        });
      }
    }

    const metadata = {
      intake: "external_machine_ingestion",
      source_system: input.sourceSystem,
      outlook_message_id: input.outlookMessageId,
      internet_message_id: input.internetMessageId,
      email_subject: input.emailSubject,
      sender: input.sender,
      attachment_id: input.attachmentId,
      idempotency_key: externalId,
      diagnostic_trace_id: traceId,
    };

    const result = await ingestArtifact({
      artifactType: input.artifactType as ArtifactType,
      sourceSystem: input.sourceSystem,
      externalId,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: decoded.bytes,
      title: input.title,
      occurredAt: input.occurredAt,
      contextHint: input.contextHint as ArtifactContextHint,
      submissionKind: "file",
      metadata,
    });

    // ingestArtifact's own content-hash dedup: same bytes arriving under a
    // different message/attachment id. Reported distinctly from the
    // idempotency-key match so the two reasons stay diagnosable.
    if (result.duplicate) {
      await emitDiagnosticEvent({
        traceId,
        module: "ingestion",
        stage: "external_intake",
        eventType: "ingestion_duplicate",
        status: "success",
        objectType: "artifact",
        objectId: result.artifactId ?? null,
        humanSummary: `Already ingested "${input.filename}" (identical content already stored)`,
        decisionType: "duplicate_skipped",
        decisionReason: "content_hash",
        metadata: { idempotency_key: externalId },
      });
      await completeTrace(traceId, { status: "completed", summary: "Duplicate: identical content already stored" });
      return NextResponse.json({
        success: true,
        duplicate: true,
        duplicateReason: "content_hash",
        artifactId: result.artifactId,
        sourceId: result.sourceId,
        contentKind: result.contentKind,
        idempotencyKey: externalId,
      });
    }

    await emitDiagnosticEvent({
      traceId,
      module: "ingestion",
      stage: "external_intake",
      eventType: "ingestion_succeeded",
      status: "success",
      objectType: "artifact",
      objectId: result.artifactId ?? null,
      humanSummary: `Ingested "${input.filename}" as a ${result.contentKind ?? "unclassified"} artifact`,
      metadata: {
        artifact_id: result.artifactId,
        source_id: result.sourceId,
        content_kind: result.contentKind,
        sections_created: result.sectionsCreated ?? 0,
        tasks_created: result.tasksCreated ?? 0,
        claims_created: result.claimsCreated ?? 0,
        stored_only: result.storedOnly ?? false,
        idempotency_key: externalId,
      },
    });
    await completeTrace(traceId, {
      status: "completed",
      summary: `Ingested ${input.filename} (${result.contentKind ?? "unclassified"})`,
    });

    return NextResponse.json({
      success: true,
      duplicate: false,
      artifactId: result.artifactId,
      sourceId: result.sourceId,
      meetingId: result.meetingId ?? null,
      contentKind: result.contentKind,
      storedOnly: result.storedOnly ?? false,
      sectionsCreated: result.sectionsCreated ?? 0,
      tasksCreated: result.tasksCreated ?? 0,
      claimsCreated: result.claimsCreated ?? 0,
      calendarMatch: result.calendarMatch ?? null,
      warnings: result.warnings ?? [],
      idempotencyKey: externalId,
      traceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ingestion error";

    /*
     * Two Power Automate retries can arrive concurrently and both pass the
     * fast-path check before either inserts. The UNIQUE (source_system,
     * external_id, version) constraint is what actually prevents the
     * duplicate; catching it here turns a 500 into the correct duplicate
     * response, so a retrying flow converges instead of alarming.
     */
    if (externalId && isUniqueViolation(error)) {
      const existing = await findExistingByIdentity(input.sourceSystem, externalId).catch(() => null);
      if (existing) {
        await emitDiagnosticEvent({
          traceId,
          module: "ingestion",
          stage: "external_intake",
          eventType: "ingestion_duplicate",
          status: "success",
          objectType: "artifact",
          objectId: existing.id,
          humanSummary: `Concurrent retry collapsed onto the existing artifact for "${input.filename}"`,
          decisionType: "duplicate_skipped",
          decisionReason: "concurrent_insert",
          metadata: { idempotency_key: externalId },
        });
        await completeTrace(traceId, { status: "completed", summary: "Duplicate: concurrent retry" });
        return NextResponse.json({
          success: true,
          duplicate: true,
          duplicateReason: "concurrent_insert",
          artifactId: existing.id,
          sourceId: existing.memory_source_id,
          contentKind: existing.content_kind,
          idempotencyKey: externalId,
        });
      }
    }

    console.error("External artifact ingestion failed:", error);
    await emitDiagnosticEvent({
      traceId,
      module: "ingestion",
      stage: "external_intake",
      eventType: "ingestion_failed",
      status: "failure",
      severity: "error",
      objectType: emailObjectId ? "email" : null,
      objectId: emailObjectId,
      humanSummary: `Failed to ingest "${input.filename}"`,
      technicalDetail: message,
    });
    await recordIssue({
      traceId,
      issueType: "external_ingestion_failed",
      severity: "error",
      humanSummary: `External artifact ingestion failed for "${input.filename}"`,
      sourceType: "external_ingestion",
      sourceId: externalId,
      retryable: true,
      technicalDetail: message,
    });
    await completeTrace(traceId, { status: "failed", summary: message });

    return NextResponse.json({ success: false, error: message, traceId }, { status: 500 });
  }
}
