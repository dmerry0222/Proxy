import "server-only";

import { interpretGenericArtifact } from "@/lib/ingestion/interpretGenericArtifact";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Priority 4: retries extraction for an artifact that already failed --
 * against the durably-stored artifact/memory_source/document_sections rows,
 * no re-upload or re-parse. Only ever re-runs the generic-artifact path
 * (interpretGenericArtifact): processMeetingArtifact unconditionally inserts
 * a new memory_source_families/meetings row with no idempotency guard, so
 * retrying a meeting-classified artifact through it would create a duplicate
 * meeting. None of the artifacts this was built for (the 8 malformed-JSON
 * failures) are meeting-classified (content_kind='general', meeting_id=null)
 * -- this deliberately throws rather than guessing for one that is.
 */
export async function retryArtifactExtraction(artifactId: string): Promise<{
  outcome: "retried";
  tasksCreated: number;
  claimsCreated: number;
  pendingContextCreated: number;
}> {
  const { data: artifact, error: artifactError } = await supabaseServer
    .from("artifacts")
    .select("id, content_kind, meeting_id, processing_status, memory_source_id, metadata")
    .eq("id", artifactId)
    .maybeSingle();
  if (artifactError || !artifact) throw new Error(`Could not load artifact ${artifactId}: ${artifactError?.message ?? "not found"}`);

  if (artifact.processing_status !== "failed") {
    throw new Error(`Artifact ${artifactId} is not in a failed state (processing_status=${artifact.processing_status}); refusing to retry to avoid creating duplicate Memory/Execute objects.`);
  }
  if (artifact.content_kind !== "general" || artifact.meeting_id) {
    throw new Error(`Artifact ${artifactId} is meeting-classified (content_kind=${artifact.content_kind}, meeting_id=${artifact.meeting_id}); retryArtifactExtraction only supports the generic-artifact path.`);
  }

  const { data: source, error: sourceError } = await supabaseServer
    .from("memory_sources")
    .select("id, title, source_at, metadata")
    .eq("id", artifact.memory_source_id)
    .maybeSingle();
  if (sourceError || !source) throw new Error(`Could not load memory source for artifact ${artifactId}: ${sourceError?.message ?? "not found"}`);

  const { data: sectionRows, error: sectionError } = await supabaseServer
    .from("document_sections")
    .select("ordinal, section_type, heading, content")
    .eq("artifact_id", artifactId)
    .order("ordinal", { ascending: true });
  if (sectionError) throw new Error(`Could not load sections for artifact ${artifactId}: ${sectionError.message}`);
  if (!sectionRows || sectionRows.length === 0) {
    throw new Error(`Artifact ${artifactId} has no stored document_sections to retry extraction against.`);
  }

  const sections = sectionRows.map((row) => ({
    ordinal: row.ordinal as number,
    sectionType: row.section_type as string,
    heading: row.heading as string | null,
    content: row.content as string,
    startLine: 0,
    endLine: 0,
  }));

  const sourceMetadata = (source.metadata ?? {}) as Record<string, unknown>;
  const submissionKind = sourceMetadata.submission_kind === "pasted_text" ? "pasted_text" : "file";
  const userIntent = typeof sourceMetadata.user_intent === "string" ? sourceMetadata.user_intent : null;

  const { data: job } = await supabaseServer
    .from("ingestion_jobs")
    .select("id, attempt_count")
    .eq("artifact_id", artifactId)
    .eq("job_type", "process_artifact")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  try {
    const derived = await interpretGenericArtifact({
      artifactId,
      sourceId: source.id,
      title: source.title as string,
      occurredAt: source.source_at as string | null,
      sections,
      userIntent,
      submissionKind,
    });

    await Promise.all([
      supabaseServer.from("artifacts").update({ processing_status: "completed", parser_status: "completed", updated_at: new Date().toISOString() }).eq("id", artifactId),
      job
        ? supabaseServer.from("ingestion_jobs").update({
            status: "completed",
            completed_at: new Date().toISOString(),
            attempt_count: (job.attempt_count ?? 1) + 1,
            last_error: null,
            result_summary: { content_kind: "general", retried: true, ...derived },
            updated_at: new Date().toISOString(),
          }).eq("id", job.id)
        : Promise.resolve(),
    ]);

    return { outcome: "retried", tasksCreated: derived.tasksCreated, claimsCreated: derived.claimsCreated, pendingContextCreated: derived.pendingContextCreated };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown retry error";
    await Promise.all([
      supabaseServer.from("artifacts").update({ processing_status: "failed", updated_at: new Date().toISOString() }).eq("id", artifactId),
      job
        ? supabaseServer.from("ingestion_jobs").update({
            status: "failed",
            completed_at: new Date().toISOString(),
            attempt_count: (job.attempt_count ?? 1) + 1,
            last_error: message,
            updated_at: new Date().toISOString(),
          }).eq("id", job.id)
        : Promise.resolve(),
    ]);
    throw error;
  }
}
