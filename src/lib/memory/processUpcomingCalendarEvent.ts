import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  calendarEventFingerprint,
  findOrCreateCalendarEventSource,
  resolveAttendeeEntities,
  updateCalendarEventSourceMetadata,
  type CalendarEventRow,
} from "@/lib/memory/calendarEventSource";
import { htmlToPlainText } from "@/lib/memory/htmlToPlainText";
import { reconcileCalendarEvent, type CalendarReconcileEvent } from "@/lib/reconciliation/calendarReconcile";
import { completeReconciliationRun, emptyCounters, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { ActorRef, ReconciliationTrigger } from "@/lib/reconciliation/types";

const CALENDAR_PROCESSOR_VERSION = 1;
const DAVE_EMAIL = "dmerry@suffolk.edu";

/*
 * Future events are context anchors, not proof anything happened. This
 * pass may legitimately create zero claims and zero pending-context
 * items — it only makes existing context retrievable and links the
 * event to resolved people.
 */
export async function processUpcomingCalendarEvent(event: CalendarEventRow, reconciliationTrigger: ReconciliationTrigger = "forward") {
  const fingerprint = calendarEventFingerprint(event);
  const { sourceId, metadata } = await findOrCreateCalendarEventSource(event);

  if (metadata.mode === "future" && metadata.content_fingerprint === fingerprint && metadata.contextual_processing_completed_at) {
    return { processed: false as const, reason: "unchanged" as const };
  }

  const attendees = (await resolveAttendeeEntities(event)).filter(
    (attendee) => attendee.email !== DAVE_EMAIL
  );

  if (attendees.length > 0) {
    const { data: existingEvidence, error: evidenceLookupError } = await supabaseServer
      .from("memory_evidence")
      .select("id")
      .eq("source_id", sourceId)
      .eq("metadata->>extraction_type", "context_anchor")
      .maybeSingle();

    if (evidenceLookupError) {
      throw new Error(`Could not check existing Calendar context evidence: ${evidenceLookupError.message}`);
    }

    let evidenceId = existingEvidence?.id as string | undefined;

    if (!evidenceId) {
      const { data: evidence, error: evidenceError } = await supabaseServer
        .from("memory_evidence")
        .insert({
          source_id: sourceId,
          evidence_type: "observation",
          content: `Upcoming meeting: ${event.subject ?? "Untitled"} at ${event.start_time ?? "unknown time"}`,
          effective_from: event.start_time,
          visibility: "normal",
          extracted_by: "system",
          metadata: {
            extraction_type: "context_anchor",
            source_type: "calendar_event",
            calendar_processor_version: CALENDAR_PROCESSOR_VERSION,
          },
        })
        .select("id")
        .single();

      if (evidenceError || !evidence) {
        throw new Error(`Could not create Calendar context evidence: ${evidenceError?.message ?? "Unknown error"}`);
      }

      evidenceId = evidence.id;
    }

    for (const attendee of attendees) {
      const { data: existingLink, error: linkLookupError } = await supabaseServer
        .from("memory_evidence_entities")
        .select("evidence_id")
        .eq("evidence_id", evidenceId)
        .eq("entity_id", attendee.entityId)
        .eq("relationship", "context")
        .maybeSingle();

      if (linkLookupError) {
        throw new Error(`Could not check Calendar context link: ${linkLookupError.message}`);
      }

      if (!existingLink) {
        const { error: linkError } = await supabaseServer
          .from("memory_evidence_entities")
          .insert({ evidence_id: evidenceId, entity_id: attendee.entityId, relationship: "context" });

        if (linkError) {
          throw new Error(`Could not link Calendar context to attendee: ${linkError.message}`);
        }
      }
    }
  }

  await updateCalendarEventSourceMetadata(sourceId, {
    ...metadata,
    event_id: event.event_id,
    calendar_processor_version: CALENDAR_PROCESSOR_VERSION,
    content_fingerprint: fingerprint,
    mode: "future",
    contextual_processing_completed_at: new Date().toISOString(),
  });

  /*
   * Action Reconciliation -- Calendar (Brief Part 1/5/9). Same isolation
   * pattern as processPastCalendarEvent.ts. Naturally idempotent the same
   * way this whole function is: an unchanged upcoming event short-circuits
   * at the top (line ~26) before ever reaching here on a later sync.
   */
  try {
    const { runId, traceId } = await startReconciliationRun({
      trigger: reconciliationTrigger,
      sourceType: "calendar_event",
      sourceId: event.event_id,
      summary: `Reconcile upcoming calendar event: ${event.subject ?? "Untitled"}`,
      metadata: { eventId: event.event_id, mode: "future" },
    });
    const counters = emptyCounters();
    try {
      const reconcileEvent: CalendarReconcileEvent = {
        eventId: event.event_id,
        subject: event.subject,
        description: event.body_html ? htmlToPlainText(event.body_html) : (event.body_preview ?? "").trim(),
        startTime: event.start_time,
        endTime: event.end_time,
        location: event.location ?? null,
        isRecurring: Boolean(event.is_recurring),
      };
      const reconciliationAttendees: ActorRef[] = attendees.map((a) => ({
        entityId: a.entityId,
        email: a.email,
        name: a.canonicalName,
      }));
      await reconcileCalendarEvent(reconcileEvent, reconciliationAttendees, runId, traceId, counters);
      await completeReconciliationRun(runId, traceId, {
        status: "completed",
        counters,
        summary: `Calendar event reconciled: ${counters.itemsCreated} created, ${counters.itemsMatched} matched, ${counters.itemsIgnored} ignored`,
      });
    } catch (innerError) {
      counters.errors += 1;
      await completeReconciliationRun(runId, traceId, {
        status: "failed",
        counters,
        summary: innerError instanceof Error ? innerError.message : "Unknown error",
      });
      throw innerError;
    }
  } catch (reconciliationError) {
    console.error("Action reconciliation failed for calendar event", event.event_id, reconciliationError);
  }

  return { processed: true as const, attendeesLinked: attendees.length };
}
