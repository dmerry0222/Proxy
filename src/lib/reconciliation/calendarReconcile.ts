import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { extractCalendarOperationalEvidence } from "./calendarEvidence";
import { findConfirmedCalendarLink } from "./matchCandidates";
import { applyConfirmedCancellationReview, applyConfirmedTimingUpdate, reconcileEnvelope } from "./reconcileEnvelope";
import { recordReconciliationDecision, type ReconciliationRunCounters } from "./runs";
import type { ActorRef } from "./types";

export type CalendarReconcileEvent = {
  eventId: string;
  subject: string | null;
  description: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  isRecurring: boolean;
};

/**
 * A meeting already covered by the richer transcript/artifact pipeline
 * (extractMeetingKnowledge.ts) should not have Calendar independently
 * re-derive the same operational state (Brief Part 6/5-past: "avoid
 * duplicating extraction already handled... prefer linking Calendar
 * evidence to the richer meeting evidence"). Calendar's own explicit-
 * deliverable classification is skipped entirely when this is true --
 * not merged/deduped after the fact, avoided up front.
 */
async function isMeetingAlreadyCovered(eventId: string): Promise<boolean> {
  const { data: links, error: linksError } = await supabaseServer
    .from("meeting_calendar_links")
    .select("meeting_id")
    .eq("calendar_event_id", eventId);
  if (linksError) {
    throw new Error(`Could not check meeting_calendar_links: ${linksError.message}`);
  }
  const meetingIds = [...new Set((links ?? []).map((row) => row.meeting_id))];
  if (meetingIds.length === 0) return false;

  const { data: artifacts, error: artifactsError } = await supabaseServer
    .from("artifacts")
    .select("id")
    .in("meeting_id", meetingIds)
    .eq("processing_status", "completed")
    .limit(1);
  if (artifactsError) {
    throw new Error(`Could not check linked meeting artifacts: ${artifactsError.message}`);
  }
  return (artifacts?.length ?? 0) > 0;
}

/**
 * Whether Calendar has previously asserted that THIS event governs a
 * linked item's timing (a supports_timing evidence row citing this exact
 * event_id) -- and if so, what start time was recorded then. Reschedule
 * detection (Brief Part 3.B) only fires when this exists: if the item's
 * timing came from somewhere else (an email deadline, a Teams
 * conversation) and Calendar is only contextually linked, a later change
 * to the event's own time must NOT silently override that timing (Brief
 * Part 3.A: "do not automatically convert every related meeting start
 * time into timing_at").
 */
async function findPriorTimingAssertion(eventId: string): Promise<{ lastKnownStart: string | null } | null> {
  const { data, error } = await supabaseServer
    .from("execution_evidence")
    .select("occurred_at")
    .eq("source_type", "calendar_event")
    .eq("source_locator->>calendar_event_id", eventId)
    .eq("relationship", "supports_timing")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not check prior calendar timing assertion: ${error.message}`);
  }
  return data ? { lastKnownStart: data.occurred_at } : null;
}

/**
 * Per-event Calendar reconciliation (Brief Part 5/9). Called by both
 * processPastCalendarEvent.ts and processUpcomingCalendarEvent.ts inside
 * their own nested try/catch (the same failure-isolation pattern proven
 * in Phase 3/4) -- a failure here never affects their already-completed
 * Memory work.
 *
 * Order of operations, each one a hard stop if it applies:
 * 1. Confirmed prior link + Calendar previously asserted this event's
 *    timing -> reschedule check only (deterministic, no AI call).
 * 2. Confirmed prior link, no timing assertion -> nothing to do; the
 *    link already represents whatever Calendar established once.
 * 3. No confirmed link, but a transcript/artifact already covers this
 *    meeting -> skip Calendar's own extraction entirely.
 * 4. No confirmed link, no coverage, no description -> nothing to
 *    classify (matches every other source's "most X produce nothing").
 * 5. Otherwise: the one AI-classification pass, gated exactly like every
 *    other source through the shared ownership gate for dave_owned, or
 *    a direct (unchanged) memory_pending_context write for prep_context.
 */
export async function reconcileCalendarEvent(
  event: CalendarReconcileEvent,
  attendees: ActorRef[],
  runId: string,
  traceId: string | null,
  counters: ReconciliationRunCounters
): Promise<void> {
  const link = await findConfirmedCalendarLink(event.eventId);

  if (link) {
    const priorTiming = await findPriorTimingAssertion(event.eventId);
    if (priorTiming && event.startTime && priorTiming.lastKnownStart !== event.startTime) {
      counters.evidenceConsidered += 1;
      const result = await applyConfirmedTimingUpdate({
        item: link,
        newTiming: { kind: "target", at: event.startTime },
        sourceType: "calendar_event",
        sourceLocator: { calendar_event_id: event.eventId },
        excerpt: `Meeting "${event.subject ?? "Untitled"}" rescheduled to ${event.startTime}`,
        occurredAt: event.startTime,
        runId,
        traceId,
      });
      if (result.executionItemId) counters.itemsMatched += 1;
      else counters.itemsIgnored += 1;
    }
    // Confirmed link with no prior timing assertion, or timing unchanged:
    // nothing new to do -- the existing link already represents this
    // event's relationship to the item.
    return;
  }

  if (await isMeetingAlreadyCovered(event.eventId)) {
    counters.evidenceConsidered += 1;
    counters.itemsIgnored += 1;
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { eventId: event.eventId },
      outcome: "no_action",
      automatic: true,
      reasoningSummary: "A meeting transcript/artifact already covers this event; Calendar does not independently re-extract.",
    });
    return;
  }

  if (!event.description.trim()) {
    return;
  }

  const classified = await extractCalendarOperationalEvidence({
    subject: event.subject,
    description: event.description,
    startTime: event.startTime,
    endTime: event.endTime,
    location: event.location,
    isRecurring: event.isRecurring,
    attendees,
  });
  counters.evidenceConsidered += classified.length;

  for (const item of classified) {
    if (item.kind === "none") {
      counters.itemsIgnored += 1;
      await recordReconciliationDecision(traceId, {
        runId,
        evidenceRef: { eventId: event.eventId, kind: item.raw.kind ?? "none" },
        outcome: "no_action",
        automatic: true,
        reasoningSummary:
          item.raw.kind && item.raw.kind !== "none"
            ? `Classified as "${item.raw.kind}" but missing a required field; no action taken.`
            : "No explicit ownership or preparation signal cleared the bar for operational action.",
      });
      continue;
    }

    if (item.kind === "dave_owned") {
      const fullEnvelope = {
        ...item.envelope,
        sourceType: "calendar_event" as const,
        sourceLocator: { calendar_event_id: event.eventId },
      };
      const result = await reconcileEnvelope({ envelope: fullEnvelope, runId, traceId });
      if (result.outcome === "create_dave_item" || result.outcome === "create_external_item") {
        counters.itemsCreated += 1;
      } else if (result.executionItemId) {
        counters.itemsMatched += 1;
      } else {
        counters.itemsIgnored += 1;
      }
      continue;
    }

    // prep_context: stays Memory pending-context, exactly like every
    // other source (Brief Part 15) -- never a duplicate execution item.
    const { data: sourceRow } = await supabaseServer
      .from("memory_sources")
      .select("id")
      .eq("canonical_table", "calendar_events")
      .eq("canonical_record_id", event.eventId)
      .maybeSingle();

    const { error: pendingError } = await supabaseServer.from("memory_pending_context").insert({
      context_type: item.contextType,
      summary: item.summary,
      detail: item.detail,
      status: "pending",
      trigger_type: "manual",
      source_id: sourceRow?.id ?? null,
      visibility: "normal",
      created_by: "ai",
      metadata: { generated_by: "calendar_reconciliation", event_id: event.eventId },
    });
    if (pendingError) {
      throw new Error(`Could not create Calendar prep-context: ${pendingError.message}`);
    }

    counters.itemsIgnored += 1;
    await recordReconciliationDecision(traceId, {
      runId,
      evidenceRef: { eventId: event.eventId },
      outcome: "pending_context_only",
      automatic: true,
      reasoningSummary: `Preparation context recorded ("${item.summary}"), not created as an execution item.`,
    });
  }
}

/**
 * Sync-level pass (Brief Part 3.C / Part 8): a calendar event previously
 * confirmed-linked to an open item that no longer appears in the current
 * sync window has most likely been cancelled -- Outlook communicates
 * cancellation by the event disappearing from subsequent snapshots (see
 * the existing reconcile_calendar() RPC's delete-stale-events behavior),
 * not by a status field on the row, so this can only be detected here,
 * at the sync-run level, by comparing what's linked against what's
 * currently present -- never from a single event's own fields.
 *
 * Deliberately bounded to the same [windowStart, windowEnd] the sync run
 * itself covers (matched against when the link was originally recorded),
 * not a full-table scan -- a link whose event lies outside this window
 * is left alone, since it hasn't been given a chance to reappear here yet.
 * Disclosed limitation: an event rescheduled to OUTSIDE the current
 * window would look identical to "vanished" from this vantage point.
 */
export async function reconcileVanishedCalendarLinks(
  windowStart: string,
  windowEnd: string,
  presentEventIds: Set<string>,
  runId: string,
  traceId: string | null,
  counters: ReconciliationRunCounters
): Promise<void> {
  const { data: evidenceRows, error } = await supabaseServer
    .from("execution_evidence")
    .select("execution_item_id, source_locator")
    .eq("source_type", "calendar_event")
    .gte("occurred_at", windowStart)
    .lte("occurred_at", windowEnd);
  if (error) {
    throw new Error(`Could not check for vanished calendar links: ${error.message}`);
  }

  const vanishedEventIdByItemId = new Map<string, string>();
  for (const row of evidenceRows ?? []) {
    const locator = row.source_locator as { calendar_event_id?: string } | null;
    const eventId = locator?.calendar_event_id;
    if (eventId && !presentEventIds.has(eventId)) {
      vanishedEventIdByItemId.set(row.execution_item_id as string, eventId);
    }
  }

  if (vanishedEventIdByItemId.size === 0) return;

  const { data: itemRows, error: itemsError } = await supabaseServer
    .from("execution_items")
    .select(
      "id, title, status, responsibility, assignee_entity_id, requester_entity_id, related_person_entity_id, project_state_id, timing_at, obligation_context, created_at"
    )
    .in("id", [...vanishedEventIdByItemId.keys()])
    .in("status", ["candidate", "active", "deferred"]);
  if (itemsError) {
    throw new Error(`Could not load vanished-link items: ${itemsError.message}`);
  }

  for (const row of itemRows ?? []) {
    counters.evidenceConsidered += 1;
    const eventId = vanishedEventIdByItemId.get(row.id) as string;
    const result = await applyConfirmedCancellationReview({
      item: {
        id: row.id,
        title: row.title,
        status: row.status,
        responsibility: row.responsibility,
        assigneeEntityId: row.assignee_entity_id,
        requesterEntityId: row.requester_entity_id,
        relatedPersonEntityId: row.related_person_entity_id,
        projectStateId: row.project_state_id,
        timingAt: row.timing_at,
        obligationContext: row.obligation_context,
        createdAt: row.created_at,
      },
      sourceType: "calendar_event",
      sourceLocator: { calendar_event_id: eventId },
      excerpt: "The previously linked calendar event no longer appears in the synced calendar.",
      occurredAt: new Date().toISOString(),
      runId,
      traceId,
    });
    if (result.executionItemId) counters.itemsMatched += 1;
  }
}
