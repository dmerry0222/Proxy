import type { ActionEvidenceEnvelope, OwnershipBasis } from "./types";

/**
 * Split out of calendarEvidence.ts specifically so it can be unit-tested:
 * calendarEvidence.ts as a whole imports the Anthropic SDK and must keep
 * `import "server-only"` to stay unreachable from client code -- the same
 * reasoning as teamsIdentity.ts/titleSimilarity.ts in Phase 4/4.5.
 *
 * isDaveOwnershipBasis is intentionally re-declared below rather than
 * imported from ownershipRules.ts: a relative .ts-to-.ts import here can't
 * simultaneously satisfy TypeScript (rejects explicit .ts extensions
 * without a compiler flag this project doesn't set) and Node's plain ESM
 * loader (requires them) -- the exact constraint titleSimilarity.ts hit
 * first. Keep this set in sync with ownershipRules.ts's
 * DAVE_OWNERSHIP_BASES if it ever changes; that file's own gate logic
 * remains the one every other source uses at runtime.
 */
const DAVE_OWNERSHIP_BASES = new Set<string>([
  "explicit_assignment_to_dave",
  "explicit_acceptance_by_dave",
  "explicit_user_intent",
]);

function isDaveOwnershipBasis(basis: string | null | undefined): basis is OwnershipBasis {
  return Boolean(basis) && DAVE_OWNERSHIP_BASES.has(basis as string);
}

export const PENDING_CONTEXT_TYPES = new Set([
  "follow_up", "waiting_on", "deferred_idea", "future_trigger", "tweak",
  "gift_idea", "performance_note", "reminder_context", "other",
]);

export type RawCalendarEvidence = {
  kind?: string;
  actionTitle?: string | null;
  ownershipBasis?: string | null;
  excerpt?: string;
  dueAt?: string | null;
  timingBasis?: string | null;
  summary?: string | null;
  detail?: string | null;
  contextType?: string | null;
};

/** Either a shared-envelope-ready Dave-owned candidate, or a direct pending-context proposal (Brief Part 15: prep context stays pending_context, never becomes a duplicate execution item). */
export type ClassifiedCalendarEvidence =
  | { kind: "dave_owned"; raw: RawCalendarEvidence; envelope: Omit<ActionEvidenceEnvelope, "sourceType" | "sourceLocator"> }
  | { kind: "prep_context"; raw: RawCalendarEvidence; summary: string; detail: string | null; contextType: string }
  | { kind: "none"; raw: RawCalendarEvidence };

export function classify(item: RawCalendarEvidence, occurredAt: string | null): ClassifiedCalendarEvidence {
  if (item.kind === "dave_owned") {
    const excerpt = item.excerpt?.trim() ?? "";
    if (!excerpt || !isDaveOwnershipBasis(item.ownershipBasis)) {
      return { kind: "none", raw: item };
    }
    const timing =
      item.dueAt && !Number.isNaN(Date.parse(item.dueAt))
        ? { kind: (item.timingBasis === "must" ? "must" : "target") as "must" | "target", at: new Date(item.dueAt).toISOString(), basis: "calendar" }
        : null;
    return {
      kind: "dave_owned",
      raw: item,
      envelope: {
        occurredAt: occurredAt ?? new Date().toISOString(),
        // Deliberately empty, not an oversight (Brief Part 11: "attendee
        // != owner", "organizer != requester"). Calendar has no reliable
        // requester signal the way email's sender or Teams' cited-message
        // author does -- an event's attendee/organizer role is never
        // enough to populate requester_entity_id. Candidate matching for
        // this item falls back to title/project signals only.
        actors: [],
        excerpt,
        candidateTitle: item.actionTitle?.trim() || null,
        ownership: { owner: "dave", basis: item.ownershipBasis as OwnershipBasis, excerpt },
        timing,
        projectHint: null,
        completion: null,
        cancellation: null,
      },
    };
  }

  if (item.kind === "prep_context") {
    const summary = item.summary?.trim();
    if (!summary) {
      return { kind: "none", raw: item };
    }
    const contextType = PENDING_CONTEXT_TYPES.has(item.contextType ?? "") ? (item.contextType as string) : "other";
    return { kind: "prep_context", raw: item, summary, detail: item.detail?.trim() || null, contextType };
  }

  return { kind: "none", raw: item };
}
