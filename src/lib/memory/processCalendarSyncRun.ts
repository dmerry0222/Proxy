import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { processUpcomingCalendarEvent } from "@/lib/memory/processUpcomingCalendarEvent";
import { processPastCalendarEvent } from "@/lib/memory/processPastCalendarEvent";
import type { CalendarEventRow } from "@/lib/memory/calendarEventSource";
import { reconcileVanishedCalendarLinks } from "@/lib/reconciliation/calendarReconcile";
import { completeReconciliationRun, emptyCounters, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { ReconciliationTrigger } from "@/lib/reconciliation/types";

export async function processCalendarSyncRun({
  runGuid,
  windowStart,
  windowEnd,
  reconciliationTrigger = "forward",
}: {
  runGuid: string;
  windowStart: string;
  windowEnd: string;
  reconciliationTrigger?: ReconciliationTrigger;
}) {
  const { data, error } = await supabaseServer
    .from("calendar_events")
    .select("event_id, subject, start_time, end_time, organizer, attendees, show_as, body_html, body_preview, location, is_recurring, ical_uid")
    .gte("start_time", windowStart)
    .lte("start_time", windowEnd);

  if (error) {
    throw new Error(`Could not load Calendar snapshot for run ${runGuid}: ${error.message}`);
  }

  const events = (data ?? []) as CalendarEventRow[];
  const now = Date.now();

  const results = [];

  for (const event of events) {
    const referenceTime = event.end_time ?? event.start_time;
    const isPast = referenceTime ? new Date(referenceTime).getTime() <= now : false;

    try {
      const result = isPast
        ? await processPastCalendarEvent(event, reconciliationTrigger)
        : await processUpcomingCalendarEvent(event, reconciliationTrigger);

      results.push({ eventId: event.event_id, mode: isPast ? "past" : "future", result });
    } catch (cause) {
      console.error(`Calendar Memory processing failed for event ${event.event_id}:`, cause);
      results.push({
        eventId: event.event_id,
        mode: isPast ? "past" : "future",
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }
  }

  // Phase 5: a calendar event previously confirmed-linked to open work
  // that no longer appears in this window's snapshot has most likely
  // been cancelled (Outlook communicates this by the event disappearing,
  // not a status field -- see reconcileVanishedCalendarLinks's own
  // documentation). Runs once per sync, not per-event.
  try {
    const { runId, traceId } = await startReconciliationRun({
      trigger: reconciliationTrigger,
      sourceType: "calendar_sync",
      sourceId: runGuid,
      summary: `Check for cancelled/vanished calendar links: run ${runGuid}`,
      metadata: { runGuid, windowStart, windowEnd },
    });
    const counters = emptyCounters();
    try {
      await reconcileVanishedCalendarLinks(
        windowStart,
        windowEnd,
        new Set(events.map((e) => e.event_id)),
        runId,
        traceId,
        counters
      );
      await completeReconciliationRun(runId, traceId, {
        status: "completed",
        counters,
        summary: `Vanished-link check: ${counters.itemsMatched} flagged for review`,
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
    console.error("Vanished-calendar-link reconciliation failed for run", runGuid, reconciliationError);
  }

  return { runGuid, windowStart, windowEnd, eventsProcessed: events.length, results };
}
