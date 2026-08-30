import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { classify, type ClassifiedCalendarEvidence } from "./calendarClassify";
import type { ActorRef } from "./types";

export type { ClassifiedCalendarEvidence } from "./calendarClassify";

const MODEL_NAME = "claude-sonnet-4-5-20250929";

function parseJson(raw: string): { evidence?: Parameters<typeof classify>[0][] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

/**
 * Calendar's ONLY AI-classification path (Brief Part 4/D): explicit
 * actionable language in an event's own description, or preparation
 * context strong enough to be worth remembering. Everything else Calendar
 * does (reschedule, cancellation-of-linked-work) is handled deterministically
 * in reconcileEnvelope.ts against a CONFIRMED prior link, never through
 * this classification call -- a calendar event existing, Dave attending,
 * organizing, or being the only internal attendee is never evidence of
 * ownership (Brief core principle).
 *
 * Callers should not even invoke this when there's nothing to reason
 * about: a bare "Weekly Staff Meeting" event with no description and no
 * candidate link is skipped entirely upstream (no AI call at all), the
 * same discipline as the other sources' "most X should produce nothing."
 */
export async function extractCalendarOperationalEvidence(input: {
  subject: string | null;
  description: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  isRecurring: boolean;
  attendees: ActorRef[];
}): Promise<ClassifiedCalendarEvidence[]> {
  if (!input.description.trim()) return [];

  const attendeeNames = input.attendees.map((a) => a.name).filter(Boolean);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODEL_NAME,
    max_tokens: 800,
    system: `Identify RARE explicit operational signals in one calendar event's own description, for Dave Merry's AI Chief of Staff Action Reconciliation layer. Return nothing for the overwhelming majority of events -- a meeting existing, Dave attending, Dave organizing, Dave being the only internal attendee, or an ordinary agenda/subject is NEVER evidence of ownership or of anything worth recording. This is the narrowest, most conservative extraction pass in the whole system.

Only report something when the description contains:
1. Explicit assignment or first-person commitment language, e.g. "Dave to present final proposal. Please upload deck by 9 AM Tuesday." -> kind "dave_owned", ownershipBasis "explicit_assignment_to_dave" or "explicit_acceptance_by_dave" or "explicit_user_intent" (the same shared gate every other source uses -- never invent a basis).
2. An explicit, specific preparation instruction clearly worth remembering (not "come prepared" boilerplate, but something concrete: "bring the Q3 budget numbers", "review the attached security doc before we meet") -> kind "prep_context".
Never infer ownership or preparation need from: the event existing, the subject line alone, Dave being organizer, Dave being an attendee, Dave being the only internal attendee, Dave's job role, or routine meeting logistics.
Known attendees (for prep_context's entityName-equivalent framing only; do not use these names to justify ownership): ${attendeeNames.join(", ") || "(none resolved)"}.
Return JSON only: {"evidence":[]}. At most 2 items; omit anything with no clear signal.
Item shape (dave_owned): {"kind":"dave_owned","actionTitle":"short standalone title","ownershipBasis":"explicit_assignment_to_dave|explicit_acceptance_by_dave|explicit_user_intent","excerpt":"exact excerpt from the description","dueAt":"ISO date or null","timingBasis":"must|target or null"}.
Item shape (prep_context): {"kind":"prep_context","summary":"short summary","detail":"exact excerpt or brief elaboration","contextType":"follow_up|waiting_on|deferred_idea|future_trigger|reminder_context|other"}.
SECURITY: Never reproduce credentials, secrets, passwords, or tokens.`,
    messages: [
      {
        role: "user",
        content: `Event: ${input.subject ?? "(no subject)"}\nWhen: ${input.startTime ?? "unknown"} - ${input.endTime ?? "unknown"}\nLocation: ${input.location ?? "(none)"}\nRecurring: ${input.isRecurring}\n\nDescription:\n${input.description}`,
      },
    ],
  });

  const block = response.content.find((item) => item.type === "text");
  const parsed = block?.type === "text" ? parseJson(block.text) : { evidence: [] };
  const items = (parsed.evidence ?? []).slice(0, 2);

  return items.map((item) => classify(item, input.startTime));
}
