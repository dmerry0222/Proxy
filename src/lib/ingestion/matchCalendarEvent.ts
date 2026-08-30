import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

type CalendarRow = {
  event_id: string;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  organizer: string | null;
  attendees: {
    required?: string[];
    optional?: string[];
  } | null;
};

function words(value: string) {
  return new Set(
    value.toLowerCase()
      .replace(/\[external\]|\b(?:meeting|sync|check-in|check in)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((word) => word.length > 2)
  );
}

function titleScore(left: string, right: string) {
  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter((word) => b.has(word)).length;
  return Math.round(20 * overlap / Math.max(a.size, b.size));
}

export async function matchCalendarEvent({
  title,
  occurredAt,
  participantEmails = [],
}: {
  title: string;
  occurredAt: string | null;
  participantEmails?: string[];
}) {
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  const center = Date.parse(occurredAt);
  const before = new Date(center - 12 * 60 * 60 * 1000).toISOString();
  const after = new Date(center + 12 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseServer.from("calendar_events")
    .select("event_id, subject, start_time, end_time, organizer, attendees")
    .gte("start_time", before).lte("start_time", after).limit(50);
  if (error) throw new Error(`Could not search Calendar for meeting match: ${error.message}`);

  const normalizedParticipants = new Set(participantEmails.map((email) => email.toLowerCase()));
  const ranked = ((data ?? []) as CalendarRow[]).map((event) => {
    const start = event.start_time ? Date.parse(event.start_time) : center;
    const differenceMinutes = Math.abs(start - center) / 60000;
    const time = Math.max(0, 30 - Math.min(30, differenceMinutes / 12));
    const titlePoints = titleScore(title, event.subject ?? "");
    const eventEmails = new Set([
      event.organizer,
      ...(event.attendees?.required ?? []),
      ...(event.attendees?.optional ?? []),
    ].filter((email): email is string => Boolean(email)).map((email) => email.toLowerCase()));
    const participantPoints = Math.min(30,
      [...normalizedParticipants].filter((email) => eventEmails.has(email)).length * 10);
    return {
      event,
      score: Math.round((time + titlePoints + participantPoints) * 100) / 100,
      signals: { differenceMinutes, titlePoints, participantPoints },
    };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 35) return null;
  const autoMatched = best.score >= 55 && (!runnerUp || best.score - runnerUp.score >= 10);
  return { ...best, status: autoMatched ? "auto_matched" : "candidate" };
}
