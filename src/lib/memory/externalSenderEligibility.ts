import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { parseRecipientList } from "./externalSenderAddressRules.ts";

export { isLikelyAutomatedSenderAddress, isSelfAddress } from "./externalSenderAddressRules.ts";

/**
 * Conservative external-sender auto-seeding evidence: the DB-backed
 * correspondence check. Address-shape rules (automated/role-account
 * detection, self-address) live in externalSenderAddressRules.ts, which
 * this module re-exports for convenience so callers only need one import.
 *
 * Design note (see the Aug/Sep 2026 Memory pipeline review): raw inbound
 * volume does NOT reliably distinguish a real correspondent from a
 * newsletter/marketing sender -- in this mailbox, no-reply@zoom.us (42
 * messages/21 days), suffolk@myworkday.com (35/18), and a partnership-
 * marketing sender emailing under a human first name (9/7 days) all
 * produced MORE messages over MORE distinct days than genuine personal
 * contacts like a family member's Gmail address (9 messages/2 days). Volume
 * and spread are recorded for observability, but the deterministic gate is
 * evidence of actual two-way correspondence: Dave has sent mail TO this
 * exact address, or this exact address co-occurs with Dave on a calendar
 * event. Both are things a one-way broadcast sender essentially never has.
 */

export type ExternalCorrespondentEvaluation = {
  eligible: boolean;
  reason: string;
  evidence: {
    incomingCount: number;
    distinctDays: number;
    hasOutgoingReply: boolean;
    hasCalendarCoPresence: boolean;
    representativeDisplayName: string | null;
  };
};

export async function evaluateExternalCorrespondent(normalizedEmail: string): Promise<ExternalCorrespondentEvaluation> {
  const emptyEvidence = {
    incomingCount: 0,
    distinctDays: 0,
    hasOutgoingReply: false,
    hasCalendarCoPresence: false,
    representativeDisplayName: null,
  };

  const { data: incomingRows, error: incomingError } = await supabaseServer
    .from("emails")
    .select("from_name, message_at, is_auto_reply, is_mailing_list, is_system_generated")
    .ilike("from_email", normalizedEmail)
    .ilike("direction", "incoming");

  if (incomingError) {
    throw new Error(`Could not evaluate external correspondent evidence: ${incomingError.message}`);
  }

  const genuineRows = (incomingRows ?? []).filter(
    (row) => !row.is_auto_reply && !row.is_mailing_list && !row.is_system_generated
  );
  const incomingCount = genuineRows.length;

  if (incomingCount === 0) {
    return {
      eligible: false,
      reason: "No genuine (non-automated-flagged) incoming messages found from this address.",
      evidence: emptyEvidence,
    };
  }

  const distinctDays = new Set(
    genuineRows.map((row) => (row.message_at ? String(row.message_at).slice(0, 10) : null)).filter(Boolean)
  ).size;
  const representativeDisplayName = genuineRows.map((row) => row.from_name?.trim()).find((name) => name) ?? null;

  const { data: outgoingRows, error: outgoingError } = await supabaseServer
    .from("emails")
    .select("to_recipients")
    .ilike("direction", "outgoing");

  if (outgoingError) {
    throw new Error(`Could not check outgoing correspondence: ${outgoingError.message}`);
  }

  const hasOutgoingReply = (outgoingRows ?? []).some((row) =>
    parseRecipientList(row.to_recipients as string[] | null).includes(normalizedEmail)
  );

  let hasCalendarCoPresence = false;
  const { data: organizerRows, error: organizerError } = await supabaseServer
    .from("calendar_events")
    .select("event_id")
    .ilike("organizer", normalizedEmail)
    .limit(1);

  if (organizerError) {
    throw new Error(`Could not check calendar organizer evidence: ${organizerError.message}`);
  }
  hasCalendarCoPresence = (organizerRows ?? []).length > 0;

  if (!hasCalendarCoPresence) {
    /*
     * `attendees` is stored inconsistently (object vs. array) across rows
     * in this dataset. Rather than depend on a specific shape, do a
     * bounded, exact-substring check against the JSON text -- safe here
     * because email addresses are effectively unique strings, and the
     * calendar table is small enough that this is cheap.
     */
    const { data: attendeeRows, error: attendeeError } = await supabaseServer
      .from("calendar_events")
      .select("attendees")
      .not("attendees", "is", null)
      .limit(2000);

    if (attendeeError) {
      throw new Error(`Could not check calendar attendee evidence: ${attendeeError.message}`);
    }

    hasCalendarCoPresence = (attendeeRows ?? []).some((row) =>
      JSON.stringify(row.attendees ?? "").toLowerCase().includes(normalizedEmail)
    );
  }

  const evidence = { incomingCount, distinctDays, hasOutgoingReply, hasCalendarCoPresence, representativeDisplayName };
  const eligible = hasOutgoingReply || hasCalendarCoPresence;

  return {
    eligible,
    reason: eligible
      ? hasOutgoingReply
        ? "Dave has sent mail to this exact address (two-way correspondence)."
        : "This exact address co-occurs with Dave on a calendar event."
      : "No two-way correspondence or calendar co-presence evidence yet.",
    evidence,
  };
}
