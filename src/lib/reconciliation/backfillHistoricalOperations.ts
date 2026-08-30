import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { ingestEmailToMemory, reconcileEmailEvidence, stripQuotedReplyHistory } from "@/lib/memory/ingestEmail";
import { htmlToPlainText } from "@/lib/memory/htmlToPlainText";
import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { processTeamsConversationDelta } from "@/lib/memory/processTeamsConversationDelta";
import { processCalendarSyncRun } from "@/lib/memory/processCalendarSyncRun";

/**
 * One-time historical operational backfill (Build: "Run a one-time
 * historical operational backfill"). Deliberately thin: every object is
 * driven through the SAME production functions live processing already
 * uses (ingestEmailToMemory, processTeamsConversationDelta,
 * processCalendarSyncRun) -- no parallel extraction pipeline, no new
 * reconciliation logic. This file only supplies the missing piece none of
 * those functions have: a bounded, resumable, chronological driver over a
 * historical date window, plus duplicate-prevention against evidence that
 * may already exist (from live processing that has since caught up to
 * part of the window).
 *
 * Cross-source ordering: Email is processed fully (chronological) before
 * Teams, before Calendar. This is a disclosed approximation, not a new
 * merged-timeline reconciler (which would itself be new architecture) --
 * within each source, chronological order is exact, so a same-source
 * completion signal always finds its earlier-created candidate. The one
 * gap: an email confirming completion of Teams-sourced work created later
 * in the window won't find that candidate yet, since all email is
 * processed before any Teams. This is reported, not hidden.
 */

type BackfillParentRun = { id: string; cursor: Record<string, unknown> };

async function loadOrCreateParentRun(
  sourceType: "backfill_email" | "backfill_teams" | "backfill_calendar",
  windowStart: string,
  windowEnd: string,
  runId?: string
): Promise<BackfillParentRun> {
  if (runId) {
    const { data, error } = await supabaseServer.from("reconciliation_runs").select("id, cursor").eq("id", runId).maybeSingle();
    if (error) throw new Error(`Could not load backfill run: ${error.message}`);
    if (data) return { id: data.id as string, cursor: (data.cursor as Record<string, unknown>) ?? {} };
  }

  const { data, error } = await supabaseServer
    .from("reconciliation_runs")
    .insert({
      trigger: "backfill",
      source_type: sourceType,
      horizon_start: windowStart,
      horizon_end: windowEnd,
      metadata: { windowStart, windowEnd },
    })
    .select("id, cursor")
    .single();
  if (error || !data) throw new Error(`Could not start backfill run: ${error?.message ?? "Unknown error"}`);
  return { id: data.id as string, cursor: (data.cursor as Record<string, unknown>) ?? {} };
}

async function saveCursor(runId: string, cursor: Record<string, unknown>, done: boolean): Promise<void> {
  await supabaseServer
    .from("reconciliation_runs")
    .update({
      cursor,
      status: done ? "completed" : "in_progress",
      ...(done ? { completed_at: new Date().toISOString() } : {}),
    })
    .eq("id", runId);
}

export type BackfillBatchResult = {
  runId: string;
  processed: number;
  duplicatesPrevented: number;
  failures: number;
  remaining: number;
  done: boolean;
};

/**
 * One bounded batch of the email backfill. Callers loop this (each call
 * independently authenticated/rate-limited) until `done: true` -- this is
 * the "process in bounded chronological windows, resumable" contract, with
 * the batch itself as the bound rather than a fixed day-slice, since email
 * volume in a day is uneven.
 */
export async function backfillEmailBatch(input: {
  windowStart: string;
  windowEnd: string;
  batchSize: number;
  runId?: string;
}): Promise<BackfillBatchResult> {
  const parent = await loadOrCreateParentRun("backfill_email", input.windowStart, input.windowEnd, input.runId);
  const after = (parent.cursor.lastProcessedAt as string | undefined) ?? input.windowStart;

  const { data: rows, error } = await supabaseServer
    .from("emails")
    .select("outlook_message_id, message_at, direction, subject, from_name, from_email, body_html, body_preview")
    .gt("message_at", after)
    .lte("message_at", input.windowEnd)
    .order("message_at", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`Could not load emails for backfill: ${error.message}`);

  const incoming = (rows ?? []).filter((row) => row.direction?.trim().toLowerCase() === "incoming");
  const batch = incoming.slice(0, input.batchSize);

  let processed = 0;
  let duplicatesPrevented = 0;
  let failures = 0;
  let lastProcessedAt = after;

  for (const row of batch) {
    lastProcessedAt = row.message_at;
    const { data: existingEvidence } = await supabaseServer
      .from("execution_evidence")
      .select("id")
      .eq("source_type", "email")
      .eq("source_locator->>outlook_message_id", row.outlook_message_id)
      .limit(1)
      .maybeSingle();

    if (existingEvidence) {
      duplicatesPrevented += 1;
      continue;
    }

    try {
      const result = await ingestEmailToMemory(row.outlook_message_id, "backfill");
      // Memory may have already ingested this email (live processing, or
      // an earlier calibration pass) at the current version, which
      // short-circuits before ever reaching reconciliation -- exactly the
      // "already-ingested Proxy data...that may have been missed before
      // the reconciliation layer existed" case this backfill exists for.
      // Force the reconciliation half directly using the same extracted
      // function ingestEmailToMemory itself calls, reusing its content
      // preparation exactly (htmlToPlainText + stripQuotedReplyHistory).
      if (!result.ingested && result.reason === "already_ingested" && result.sourceId) {
        const resolution = await resolveMemoryEntityByEmail(row.from_email);
        if (resolution) {
          const rawContent = row.body_html ? htmlToPlainText(row.body_html) : (row.body_preview ?? "").trim();
          await reconcileEmailEvidence({
            outlookMessageId: row.outlook_message_id,
            establishedSourceId: result.sourceId,
            subject: row.subject,
            messageAt: row.message_at,
            senderName: row.from_name,
            senderEmail: row.from_email,
            senderEntityId: resolution.entityId,
            content: stripQuotedReplyHistory(rawContent),
            trigger: "backfill",
          });
        }
      }
      processed += 1;
    } catch (err) {
      failures += 1;
      console.error("Backfill: email ingestion failed", row.outlook_message_id, err);
    }
  }

  const remainingCount = incoming.length - batch.length;
  const done = remainingCount === 0;
  const cursor = {
    lastProcessedAt,
    processedCount: ((parent.cursor.processedCount as number) ?? 0) + processed,
    duplicatesPrevented: ((parent.cursor.duplicatesPrevented as number) ?? 0) + duplicatesPrevented,
    failures: ((parent.cursor.failures as number) ?? 0) + failures,
  };
  await saveCursor(parent.id, cursor, done);

  return { runId: parent.id, processed, duplicatesPrevented, failures, remaining: remainingCount, done };
}

/**
 * One bounded batch of the Teams backfill. Teams reconciliation is driven
 * per-chat (processTeamsConversationDelta), each call handling up to 200
 * messages for one chat -- so "one batch" here means "advance every chat
 * that has pending historical messages by one delta call each," looping
 * naturally as a resumable unit. A chat's watermark is rewound to the
 * backfill window's start only if it isn't already earlier (never moved
 * forward, never reprocessing anything live processing has already
 * covered more recently).
 */
export async function backfillTeamsBatch(input: { windowStart: string; windowEnd: string; runId?: string }): Promise<BackfillBatchResult> {
  const parent = await loadOrCreateParentRun("backfill_teams", input.windowStart, input.windowEnd, input.runId);

  const { data: chatRows, error } = await supabaseServer
    .from("teams_messages")
    .select("chat_id")
    .gte("created_at", input.windowStart)
    .lte("created_at", input.windowEnd)
    .not("body_text", "is", null);
  if (error) throw new Error(`Could not load Teams chats for backfill: ${error.message}`);
  const chatIds = [...new Set((chatRows ?? []).map((row) => row.chat_id as string))];

  const rewoundChats = (parent.cursor.rewoundChats as string[]) ?? [];
  let processed = 0;
  let failures = 0;
  let stillPending = 0;

  for (const chatId of chatIds) {
    if (!rewoundChats.includes(chatId)) {
      const { data: family } = await supabaseServer
        .from("memory_source_families")
        .select("id, metadata")
        .eq("family_type", "teams_conversation")
        .eq("metadata->>chat_id", chatId)
        .maybeSingle();

      const currentWatermark = (family?.metadata as { last_processed_message_at?: string } | undefined)?.last_processed_message_at;
      if (!currentWatermark || new Date(currentWatermark) > new Date(input.windowStart)) {
        if (family) {
          await supabaseServer
            .from("memory_source_families")
            .update({ metadata: { ...family.metadata, last_processed_message_at: input.windowStart } })
            .eq("id", family.id);
        }
        // If no family exists yet, processTeamsConversationDelta's own
        // findOrCreateChatFamily will create one with no watermark (i.e.
        // "since the beginning") -- acceptable here since a chat with no
        // family has never been processed at all, so there is no
        // narrower correct starting point than "everything."
      }
      rewoundChats.push(chatId);
    }

    try {
      const result = await processTeamsConversationDelta(chatId, "backfill");
      if (result.processed > 0) {
        processed += result.processed;
        stillPending += 1; // may have more beyond this 200-message batch
      }
    } catch (err) {
      failures += 1;
      console.error("Backfill: Teams delta failed", chatId, err);
    }
  }

  const done = stillPending === 0;
  const cursor = {
    rewoundChats,
    processedCount: ((parent.cursor.processedCount as number) ?? 0) + processed,
    failures: ((parent.cursor.failures as number) ?? 0) + failures,
  };
  await saveCursor(parent.id, cursor, done);

  return { runId: parent.id, processed, duplicatesPrevented: 0, failures, remaining: stillPending, done };
}

/**
 * Calendar already takes a window directly -- no batching needed, its own
 * fingerprint-gated idempotency (Phase 5) makes the whole window safe in
 * one call.
 */
export async function backfillCalendarWindow(input: { windowStart: string; windowEnd: string }) {
  return processCalendarSyncRun({
    runGuid: `backfill-${input.windowStart}-${input.windowEnd}`,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    reconciliationTrigger: "backfill",
  });
}
