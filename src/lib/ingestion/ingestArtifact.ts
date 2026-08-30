import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { interpretGenericArtifact } from "@/lib/ingestion/interpretGenericArtifact";
import { parseDocument } from "@/lib/ingestion/parseDocument";
import { processMeetingArtifact } from "@/lib/ingestion/processMeetingArtifact";
import type { IngestionInput, IngestionResult, ParsedDocument } from "@/lib/ingestion/types";
import { supabaseServer } from "@/lib/supabase/server";

const STORAGE_BUCKET = "meeting-artifacts";

function extension(filename: string) {
  return filename.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "bin";
}

function stringValue(frontmatter: ParsedDocument["frontmatter"], keys: string[]) {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isVttTranscript(parsed: ParsedDocument, mimeType: string) {
  return mimeType === "text/vtt" && /(?:^|\n)\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->\s+/m.test(parsed.text);
}

function shouldProcessAsMeeting(input: IngestionInput, parsed: ParsedDocument) {
  if (input.contextHint === "meeting") return true;
  if (input.contextHint === "general") return false;
  if (input.artifactType === "transcript" || isVttTranscript(parsed, input.mimeType)) return true;
  return Boolean(input.metadata?.meeting_id || input.metadata?.calendar_event_id || input.metadata?.provider_meeting_id);
}

export async function ingestArtifact(input: IngestionInput): Promise<IngestionResult> {
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const { data: duplicate, error: duplicateError } = await supabaseServer.from("artifacts")
    .select("id, meeting_id, memory_source_id, content_kind").eq("content_hash", contentHash).maybeSingle();
  if (duplicateError) throw new Error(`Could not check duplicate artifact: ${duplicateError.message}`);
  if (duplicate) return { duplicate: true, artifactId: duplicate.id,
    meetingId: duplicate.meeting_id ?? undefined, sourceId: duplicate.memory_source_id,
    contentKind: duplicate.content_kind };

  const artifactId = randomUUID();
  const storagePath = `artifacts/${artifactId}/original/${contentHash}.${extension(input.filename)}`;
  const { error: uploadError } = await supabaseServer.storage.from(STORAGE_BUCKET)
    .upload(storagePath, input.bytes, { contentType: input.mimeType, upsert: false });
  if (uploadError) throw new Error(`Could not durably store original artifact: ${uploadError.message}`);

  const initialTitle = input.title?.trim() || input.filename.replace(/\.[^.]+$/, "");
  const sourceType = input.submissionKind === "pasted_text" ? "user_statement" : "uploaded_document";
  const { data: source, error: sourceError } = await supabaseServer.from("memory_sources").insert({
    source_type: sourceType, title: initialTitle, canonical_table: "artifacts",
    canonical_record_id: artifactId, storage_bucket: STORAGE_BUCKET, storage_path: storagePath,
    source_at: input.occurredAt ?? null,
    metadata: { artifact_type: input.artifactType, source_system: input.sourceSystem,
      content_hash: contentHash, submission_kind: input.submissionKind ?? "file",
      user_intent: input.userIntent ?? null },
  }).select("id").single();
  if (sourceError || !source) throw new Error(`Original stored, but Memory source creation failed: ${sourceError?.message ?? "Unknown error"}`);

  const { data: artifact, error: artifactError } = await supabaseServer.from("artifacts").insert({
    id: artifactId, meeting_id: null, memory_source_id: source.id, content_kind: "unclassified",
    artifact_type: input.artifactType, source_system: input.sourceSystem,
    external_id: input.externalId ?? null, original_filename: input.filename,
    mime_type: input.mimeType, storage_bucket: STORAGE_BUCKET, storage_path: storagePath,
    content_hash: contentHash, parser_status: "processing", processing_status: "processing",
    metadata: { ...input.metadata, context_hint: input.contextHint ?? "auto",
      submission_kind: input.submissionKind ?? "file", user_intent: input.userIntent ?? null },
  }).select("id").single();
  if (artifactError || !artifact) throw new Error(`Original stored, but artifact registration failed: ${artifactError?.message ?? "Unknown error"}`);

  const { data: job, error: jobError } = await supabaseServer.from("ingestion_jobs").insert({
    artifact_id: artifact.id, job_type: "process_artifact", status: "processing", attempt_count: 1,
    started_at: new Date().toISOString(), result_summary: {},
  }).select("id").single();
  if (jobError || !job) throw new Error(`Could not create artifact processing job: ${jobError?.message ?? "Unknown error"}`);

  try {
    const parsed = await parseDocument(input.bytes, input.mimeType);
    if (!parsed.supported) {
      await Promise.all([
        supabaseServer.from("artifacts").update({ content_kind: "general", parser_status: "unsupported",
          processing_status: "completed", metadata: { ...input.metadata, parser_name: parsed.parserName,
            context_hint: input.contextHint ?? "auto", user_intent: input.userIntent ?? null } }).eq("id", artifact.id),
        supabaseServer.from("ingestion_jobs").update({ status: "completed", completed_at: new Date().toISOString(),
          result_summary: { stored_only: true, reason: "parser_not_implemented" } }).eq("id", job.id),
      ]);
      return { duplicate: false, artifactId: artifact.id, sourceId: source.id, storedOnly: true,
        contentKind: "general", sectionsCreated: 0, tasksCreated: 0, claimsCreated: 0,
        warnings: [`${input.mimeType} is stored safely; its parser is not implemented yet.`] };
    }

    const title = input.title?.trim() || stringValue(parsed.frontmatter, ["title", "meeting_title", "subject"]) || initialTitle;
    const occurredAt = input.occurredAt || stringValue(parsed.frontmatter, ["meeting_at", "occurred_at", "date"]);
    const meeting = shouldProcessAsMeeting(input, parsed);
    await Promise.all([
      supabaseServer.from("artifacts").update({ parser_status: "completed", frontmatter: parsed.frontmatter,
        parser_version: parsed.parserVersion, content_kind: meeting ? "unclassified" : "general",
        metadata: { ...input.metadata, parser_name: parsed.parserName, context_hint: input.contextHint ?? "auto",
          submission_kind: input.submissionKind ?? "file", user_intent: input.userIntent ?? null } }).eq("id", artifact.id),
      supabaseServer.from("memory_sources").update({ title, source_at: occurredAt, content_text: parsed.text,
        metadata: { artifact_type: input.artifactType, source_system: input.sourceSystem, content_hash: contentHash,
          parser_name: parsed.parserName, parser_version: parsed.parserVersion,
          submission_kind: input.submissionKind ?? "file", user_intent: input.userIntent ?? null } }).eq("id", source.id),
    ]);
    if (parsed.sections.length) {
      const { error } = await supabaseServer.from("document_sections").insert(parsed.sections.map((section) => ({
        artifact_id: artifact.id, ordinal: section.ordinal, section_type: section.sectionType,
        heading: section.heading, content: section.content, start_line: section.startLine,
        end_line: section.endLine, locator: { start_line: section.startLine, end_line: section.endLine },
      })));
      if (error) throw new Error(`Could not save document sections: ${error.message}`);
    }

    const derived = meeting
      ? await processMeetingArtifact({ artifactId: artifact.id, sourceId: source.id, title, occurredAt,
          artifactType: input.artifactType, sourceSystem: input.sourceSystem, parsed })
      : await interpretGenericArtifact({ artifactId: artifact.id, sourceId: source.id, title, occurredAt,
          sections: parsed.sections, userIntent: input.userIntent?.trim() || null,
          submissionKind: input.submissionKind ?? "file" });
    const contentKind = meeting ? "meeting" : "general";
    await Promise.all([
      supabaseServer.from("artifacts").update({ processing_status: "completed", content_kind: contentKind,
        updated_at: new Date().toISOString() }).eq("id", artifact.id),
      supabaseServer.from("ingestion_jobs").update({ status: "completed", completed_at: new Date().toISOString(),
        result_summary: { content_kind: contentKind, sections_created: parsed.sections.length, ...derived },
        updated_at: new Date().toISOString() }).eq("id", job.id),
    ]);
    return { duplicate: false, artifactId: artifact.id, sourceId: source.id,
      contentKind, sectionsCreated: parsed.sections.length, ...derived };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    await Promise.all([
      supabaseServer.from("artifacts").update({ parser_status: "failed", processing_status: "failed",
        updated_at: new Date().toISOString() }).eq("id", artifact.id),
      supabaseServer.from("ingestion_jobs").update({ status: "failed", completed_at: new Date().toISOString(),
        last_error: message, updated_at: new Date().toISOString() }).eq("id", job.id),
    ]);
    throw error;
  }
}
