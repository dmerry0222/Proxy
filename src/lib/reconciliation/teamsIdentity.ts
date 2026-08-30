import type { ActorRef } from "./types";

/**
 * Pure, I/O-free identity logic split out of teamsEvidence.ts specifically
 * so it can be unit-tested -- everything else in this module tree sits
 * behind `import "server-only"` (Next.js server-module resolution), which
 * this repo's plain-Node test runner can't load (see test-ownership-rules.mjs
 * and Phase 2/3/4's reports for the same constraint). This file has no
 * imports beyond a type, so it's safe to run anywhere.
 */

export type SpeakerMessage = {
  index: number;
  speakerActor: ActorRef | null;
  isDave: boolean;
};

/**
 * Deterministically derives the counterpart from cited-message authorship
 * (Phase 4.5 Finding C) -- who spoke a given message is source metadata,
 * not an inference, so it beats a model-generated name every time it's
 * available. Returns null (never fabricates) when no cited message
 * resolves to a known, non-Dave speaker -- callers fall back to a
 * model-supplied name only in that case.
 *
 * - dave_owned: the requester is whoever (non-Dave) is cited alongside
 *   Dave's acceptance/assignment -- the first non-Dave speaker in message
 *   order (usually the one who made the ask).
 * - external_owned / completion / cancellation: the counterpart is
 *   whoever authored the cited commitment/confirmation -- the most recent
 *   non-Dave speaker (the one actually making the statement in question).
 */
export function deterministicCounterpart(kind: string, citedMessages: SpeakerMessage[]): ActorRef | null {
  const ordered = [...citedMessages].sort((a, b) => a.index - b.index);
  const nonDaveAuthors = ordered.filter((m) => m.speakerActor && !m.isDave);
  if (nonDaveAuthors.length === 0) return null;

  if (kind === "external_owned" || kind === "completion" || kind === "cancellation") {
    return nonDaveAuthors[nonDaveAuthors.length - 1].speakerActor;
  }
  if (kind === "dave_owned") {
    return nonDaveAuthors[0].speakerActor;
  }
  return null;
}
