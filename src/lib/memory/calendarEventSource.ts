import "server-only";

import { createHash } from "node:crypto";

import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { supabaseServer } from "@/lib/supabase/server";

export type CalendarEventRow = {
  event_id: string;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  organizer: string | null;
  attendees: { required?: string[]; optional?: string[] } | null;
  show_as: string | null;
  // Optional: only present when the caller's SELECT fetched them (Phase 5
  // Calendar reconciliation needs these; Memory's own fingerprint/claims
  // pipeline above does not and is unaffected by their presence/absence).
  body_html?: string | null;
  body_preview?: string | null;
  location?: string | null;
  is_recurring?: boolean | null;
  ical_uid?: string | null;
};

export type CalendarSourceMetadata = {
  event_id?: string;
  calendar_processor_version?: number;
  content_fingerprint?: string;
  mode?: "future" | "past";
  contextual_processing_completed_at?: string;
  retrospective_status?: "pending" | "initial_done" | "complete";
  retrospective_initial_at?: string;
  retrospective_revisit_eligible_at?: string;
  retrospective_completed_at?: string;
  reconciliation_attempts?: number;
};

export function attendeeEmails(event: CalendarEventRow) {
  return [
    ...new Set(
      [event.organizer, ...(event.attendees?.required ?? []), ...(event.attendees?.optional ?? [])]
        .filter((email): email is string => Boolean(email))
        .map((email) => email.trim().toLowerCase())
    ),
  ];
}

export function calendarEventFingerprint(event: CalendarEventRow) {
  const stable = JSON.stringify({
    subject: event.subject ?? "",
    start: event.start_time ?? "",
    end: event.end_time ?? "",
    organizer: event.organizer ?? "",
    attendees: attendeeEmails(event).sort(),
    showAs: event.show_as ?? "",
  });

  return createHash("sha256").update(stable).digest("hex");
}

export async function findOrCreateCalendarEventSource(event: CalendarEventRow) {
  const { data: existing, error: existingError } = await supabaseServer
    .from("memory_sources")
    .select("id, metadata")
    .eq("canonical_table", "calendar_events")
    .eq("canonical_record_id", event.event_id)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Could not check Calendar Memory source: ${existingError.message}`);
  }

  if (existing) {
    return { sourceId: existing.id, metadata: (existing.metadata ?? {}) as CalendarSourceMetadata };
  }

  const { data: created, error: createError } = await supabaseServer
    .from("memory_sources")
    .insert({
      source_type: "other",
      title: event.subject ?? "Calendar event",
      canonical_table: "calendar_events",
      canonical_record_id: event.event_id,
      content_text: event.subject ?? "",
      source_at: event.start_time,
      metadata: { event_id: event.event_id },
    })
    .select("id, metadata")
    .single();

  if (createError || !created) {
    throw new Error(`Could not create Calendar Memory source: ${createError?.message ?? "Unknown error"}`);
  }

  return { sourceId: created.id, metadata: (created.metadata ?? {}) as CalendarSourceMetadata };
}

export async function updateCalendarEventSourceMetadata(sourceId: string, metadata: CalendarSourceMetadata) {
  const { error } = await supabaseServer
    .from("memory_sources")
    .update({ metadata })
    .eq("id", sourceId);

  if (error) {
    throw new Error(`Could not update Calendar Memory source metadata: ${error.message}`);
  }
}

export async function resolveAttendeeEntities(event: CalendarEventRow) {
  const emails = attendeeEmails(event);
  const resolved: { entityId: string; canonicalName: string; email: string }[] = [];

  for (const email of emails) {
    const resolution = await resolveMemoryEntityByEmail(email);
    if (resolution) {
      resolved.push({ entityId: resolution.entityId, canonicalName: resolution.canonicalName, email });
    }
  }

  return resolved;
}
