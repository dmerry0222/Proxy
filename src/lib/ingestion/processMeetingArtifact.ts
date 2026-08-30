import "server-only";

import { extractMeetingKnowledge } from "@/lib/ingestion/extractMeetingKnowledge";
import { matchCalendarEvent } from "@/lib/ingestion/matchCalendarEvent";
import type { ParsedDocument } from "@/lib/ingestion/types";
import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { supabaseServer } from "@/lib/supabase/server";

function stringValue(frontmatter: ParsedDocument["frontmatter"], keys: string[]) {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function participantEmails(frontmatter: ParsedDocument["frontmatter"]) {
  const values = [frontmatter.participants, frontmatter.attendees, frontmatter.participant_emails];
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value :
    typeof value === "string" ? value.split(",") : [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)))];
}

export async function processMeetingArtifact({ artifactId, sourceId, title, occurredAt,
  artifactType, sourceSystem, parsed }: { artifactId: string; sourceId: string;
  title: string; occurredAt: string | null; artifactType: string; sourceSystem: string;
  parsed: ParsedDocument }) {
  const { data: family, error: familyError } = await supabaseServer.from("memory_source_families")
    .insert({ family_type: "meeting", name: title, occurred_at: occurredAt,
      metadata: { created_by: "artifact_ingestion", source_system: sourceSystem } })
    .select("id").single();
  if (familyError || !family) throw new Error(`Could not create meeting source family: ${familyError?.message ?? "Unknown error"}`);

  const { data: meeting, error: meetingError } = await supabaseServer.from("meetings").insert({
    source_family_id: family.id, title, scheduled_start: occurredAt,
    meeting_type: stringValue(parsed.frontmatter, ["meeting_type"]) ?? "meeting",
    confidentiality: stringValue(parsed.frontmatter, ["confidentiality", "sensitivity"]) ?? "internal",
    metadata: { frontmatter: parsed.frontmatter, source_system: sourceSystem },
  }).select("id").single();
  if (meetingError || !meeting) throw new Error(`Could not create meeting: ${meetingError?.message ?? "Unknown error"}`);

  const sourceType = artifactType === "transcript" ? "meeting_transcript" : "meeting_note";
  const updates = await Promise.all([
    supabaseServer.from("artifacts").update({ meeting_id: meeting.id, content_kind: "meeting" }).eq("id", artifactId),
    supabaseServer.from("memory_sources").update({ source_family_id: family.id, source_type: sourceType }).eq("id", sourceId),
  ]);
  const updateError = updates.find((result) => result.error)?.error;
  if (updateError) throw new Error(`Could not specialize artifact as a meeting: ${updateError.message}`);

  const emails = participantEmails(parsed.frontmatter);
  const calendar = await matchCalendarEvent({ title, occurredAt, participantEmails: emails });
  if (calendar) {
    const { error } = await supabaseServer.from("meeting_calendar_links").insert({
      meeting_id: meeting.id, calendar_event_id: calendar.event.event_id,
      match_status: calendar.status, match_method: "time_title_participants_v1",
      match_score: calendar.score, matching_signals: calendar.signals,
    });
    if (error) throw new Error(`Could not save Calendar match: ${error.message}`);
    emails.push(...[calendar.event.organizer, ...(calendar.event.attendees?.required ?? []),
      ...(calendar.event.attendees?.optional ?? [])].filter((email): email is string => Boolean(email))
      .map((email) => email.toLowerCase()));
  }

  for (const email of [...new Set(emails)]) {
    const resolution = await resolveMemoryEntityByEmail(email);
    if (!resolution) continue;
    const { error } = await supabaseServer.from("meeting_participants").upsert({
      meeting_id: meeting.id, entity_id: resolution.entityId, participant_role: "participant",
      attendance_status: "invited", attendance_basis: calendar ? "calendar" : "frontmatter",
      source_id: sourceId, confidence: calendar ? 0.8 : 0.6, metadata: { email },
    }, { onConflict: "meeting_id,entity_id,participant_role" });
    if (error) throw new Error(`Could not save meeting participant: ${error.message}`);
  }

  const extraction = await extractMeetingKnowledge({ meetingId: meeting.id, artifactId, sourceId,
    title, occurredAt, sections: parsed.sections, participantEmails: [...new Set(emails)] });
  return { meetingId: meeting.id, calendarMatch: calendar ? { eventId: calendar.event.event_id,
    subject: calendar.event.subject, score: calendar.score, status: calendar.status } : null, ...extraction };
}
