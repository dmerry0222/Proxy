import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { ingestEmailToMemory } from "@/lib/memory/ingestEmail";

const CANDIDATE_LIMIT = 200;
const FALLBACK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/*
 * Small overlap so an email that lands with the same (or slightly
 * earlier-appearing, due to sync lag) message_at as the current
 * high-water mark is never silently skipped. ingestEmailToMemory's own
 * versioned idempotency makes reprocessing a harmless no-op.
 */
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

const FOLDER_ALIASES: Record<string, string[]> = {
  inbox: ["inbox"],
  sent: ["sent", "sent items", "sentitems"],
  archive: ["archive", "archived"],
};

type EmailRow = {
  outlook_message_id: string;
  subject: string | null;
  message_at: string | null;
  direction: string | null;
  folder: string | null;
};

async function findEmailProcessingWatermark(): Promise<string> {
  const { data, error } = await supabaseServer
    .from("memory_sources")
    .select("source_at")
    .eq("canonical_table", "emails")
    .not("source_at", "is", null)
    .order("source_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not determine email Memory processing watermark: ${error.message}`);
  }

  if (!data?.source_at) {
    return new Date(Date.now() - FALLBACK_LOOKBACK_MS).toISOString();
  }

  return new Date(new Date(data.source_at).getTime() - WATERMARK_OVERLAP_MS).toISOString();
}

/*
 * Unlike Teams and Calendar, source_sync_runs.external_run_id does not
 * key directly into `emails`. Since-when-processed lives implicitly in
 * the Memory sources already created for emails (source_at), and
 * per-email idempotency is already handled by ingestEmailToMemory's
 * memory_ingestion_version check — this reuses both rather than adding
 * new state.
 */
export async function processEmailSyncRun(scope: string) {
  const since = await findEmailProcessingWatermark();
  const aliases = FOLDER_ALIASES[scope.toLowerCase()];

  let query = supabaseServer
    .from("emails")
    .select("outlook_message_id, subject, message_at, direction, folder")
    .gte("message_at", since)
    .order("message_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);

  if (aliases) {
    query = query.or(aliases.map((alias) => `folder.ilike.${alias}`).join(","));
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Could not load emails for scope "${scope}": ${error.message}`);
  }

  const candidates = ((data ?? []) as EmailRow[]).filter(
    (row) => row.direction?.trim().toLowerCase() === "incoming"
  );

  const results = [];
  let processed = 0;
  let alreadyIngested = 0;
  let claimsCreated = 0;
  let pendingCreated = 0;

  for (const email of candidates) {
    try {
      const result = await ingestEmailToMemory(email.outlook_message_id);

      if (result.reason === "already_ingested") {
        alreadyIngested += 1;
      } else if (result.ingested) {
        processed += 1;
        if ("claimsCreated" in result) claimsCreated += result.claimsCreated ?? 0;
        if ("pendingCreated" in result) pendingCreated += result.pendingCreated ?? 0;
      }

      results.push({ outlookMessageId: email.outlook_message_id, subject: email.subject, result });
    } catch (cause) {
      console.error(`Email Memory ingestion failed for ${email.outlook_message_id}:`, cause);
      results.push({
        outlookMessageId: email.outlook_message_id,
        subject: email.subject,
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }
  }

  return {
    scope,
    since,
    candidates: candidates.length,
    processed,
    alreadyIngested,
    claimsCreated,
    pendingCreated,
    results,
  };
}
