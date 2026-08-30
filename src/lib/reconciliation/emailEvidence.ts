import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { isDaveOwnershipBasis, isExternalOwnershipBasis } from "./ownershipRules";
import type { ActionEvidenceEnvelope, ActorRef, OwnershipBasis } from "./types";

const MODEL_NAME = "claude-sonnet-4-5-20250929";

type RawOperationalEvidence = {
  kind?: string;
  actionTitle?: string | null;
  ownershipBasis?: string | null;
  excerpt?: string;
  externalActorEmail?: string | null;
  dueAt?: string | null;
  timingBasis?: string | null;
};

function parseJson(raw: string): { operationalEvidence?: RawOperationalEvidence[] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

/**
 * One raw AI-classified item paired with the envelope it produces, or
 * `null` when it doesn't clear the bar for operational action (kind
 * "none", or a malformed/untrusted basis) -- the caller records a
 * no_action reconciliation decision for those rather than silently
 * dropping them, matching Phase 2's "a decision for every raw candidate"
 * discipline.
 */
export type ClassifiedEmailEvidence = {
  raw: RawOperationalEvidence;
  envelope: Omit<ActionEvidenceEnvelope, "sourceType" | "sourceLocator"> | null;
};

/**
 * Extracts operational (Execute-relevant) evidence from one email, as a
 * SEPARATE, additional model call alongside ingestEmail.ts's existing
 * Memory extraction -- deliberately not folded into that call, so a
 * failure or change here can never affect Memory's claim/pending-context
 * behavior (Brief Part 8: "Keep Memory extraction unchanged").
 *
 * Most emails should produce nothing. Distinguishes explicit requests TO
 * Dave, explicit commitments BY someone else, and vague/no-owner language
 * -- Memory's pending_context extraction does not make this distinction
 * structurally (see Phase 1 audit notes), so this call exists precisely
 * to supply it.
 */
export async function extractEmailOperationalEvidence(input: {
  subject: string | null;
  messageAt: string | null;
  senderName: string | null;
  senderEmail: string | null;
  senderEntityId: string;
  content: string;
}): Promise<ClassifiedEmailEvidence[]> {
  if (!input.content.trim()) return [];

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODEL_NAME,
    max_tokens: 1000,
    system: `Identify operational work signals in one email for Dave Merry's AI Chief of Staff Action Reconciliation layer.

CHECK FIRST, before deciding there is nothing to report: does this email contain any of these?
1. Dave is directly addressed and asked, instructed, or assigned to do something -- a question ("could/can/would you..."), an imperative ("please..."), or a direct assignment. -> kind "dave_owned", ownershipBasis "explicit_assignment_to_dave".
2. Dave (as the message's own author) states he will do something, or explicitly agrees to a prior ask. -> kind "dave_owned", ownershipBasis "explicit_acceptance_by_dave" or "explicit_user_intent".
3. Someone else, speaking about themselves, commits to doing or sending something -- often naming Dave as the recipient. -> kind "external_owned", ownershipBasis "explicit_external_commitment".
4. The email expresses thanks, confirmation, or acknowledgment that something Dave was expected to deliver has arrived or is done. -> kind "completion".
5. The email says a commitment involving Dave no longer applies, changed hands, or was superseded. -> kind "cancellation".
If NONE of these clearly applies -- a vague suggestion, someone else's task, broad discussion with no explicit ask or commitment -- do not return an item for that content. Never infer Dave ownership from importance, broad job-domain relevance, meeting attendance, group addressing, or passive voice. Uncertain ownership means no item.

Worked examples (all of these ARE reportable -- do not under-extract clear cases like these):
- "Dave, could you send the revised draft by Tuesday?" -> dave_owned / explicit_assignment_to_dave.
- "Dave, please send the revised draft by Tuesday." -> dave_owned / explicit_assignment_to_dave.
- "Can you get me the revised draft by Tuesday?" (addressed directly to Dave) -> dave_owned / explicit_assignment_to_dave.
- "I'll send Dave the revised draft Tuesday." (the sender speaking about themselves) -> external_owned / explicit_external_commitment. This is NOT a Dave task.
- "We should revise the draft sometime." -> nothing. No explicit owner, no task.
- "Thanks, Dave -- this revised version looks good." -> completion.
- "Never mind, ITS is handling this instead." -> cancellation.

Every item you return MUST include a non-empty, verbatim "excerpt" and (for dave_owned/external_owned) a valid "ownershipBasis" -- if you cannot supply both, do not emit that item at all.
Return JSON only: {"operationalEvidence":[]}. At most 3 items; omit anything with no clear signal entirely rather than including it.
Item shape: {"kind":"dave_owned|external_owned|completion|cancellation","actionTitle":"short standalone title","ownershipBasis":"explicit_assignment_to_dave|explicit_acceptance_by_dave|explicit_user_intent|explicit_external_commitment|explicit_external_assignment or null for completion/cancellation","excerpt":"exact supporting excerpt","externalActorEmail":"email of the external owner if named/inferable, else null","dueAt":"ISO date or null","timingBasis":"must|target or null"}.
SECURITY: Never reproduce credentials, secrets, passwords, or tokens.`,
    messages: [
      {
        role: "user",
        content: `Email subject: ${input.subject ?? "(no subject)"}\nSent: ${input.messageAt ?? "Unknown"}\nFrom: ${input.senderName ?? ""} <${input.senderEmail ?? ""}>\n\n${input.content}`,
      },
    ],
  });

  const block = response.content.find((item) => item.type === "text");
  const parsed = block?.type === "text" ? parseJson(block.text) : { operationalEvidence: [] };
  const items = (parsed.operationalEvidence ?? []).slice(0, 3);

  const senderActor: ActorRef = { entityId: input.senderEntityId, email: input.senderEmail, name: input.senderName };

  const results: ClassifiedEmailEvidence[] = [];
  for (const item of items) {
    results.push(await classify(item, input, senderActor));
  }
  return results;
}

async function classify(
  item: RawOperationalEvidence,
  input: { subject: string | null; messageAt: string | null; senderEmail: string | null; senderName: string | null },
  senderActor: ActorRef
): Promise<ClassifiedEmailEvidence> {
  const occurredAt = input.messageAt ?? new Date().toISOString();
  const excerpt = item.excerpt?.trim() ?? "";
  const timing =
    item.dueAt && !Number.isNaN(Date.parse(item.dueAt))
      ? { kind: (item.timingBasis === "must" ? "must" : "target") as "must" | "target", at: new Date(item.dueAt).toISOString(), basis: "email" }
      : null;

  if (item.kind === "dave_owned") {
    if (!excerpt || !isDaveOwnershipBasis(item.ownershipBasis)) {
      return { raw: item, envelope: null };
    }
    // Phase 4.5 Finding C audit: the requester/counterpart here is already
    // fully deterministic -- an email has exactly one author, and a
    // request/commitment TO Dave structurally comes FROM that author. No
    // model-supplied identity is needed or used.
    return {
      raw: item,
      envelope: {
        occurredAt,
        actors: [senderActor],
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

  if (item.kind === "external_owned") {
    if (!excerpt || !isExternalOwnershipBasis(item.ownershipBasis)) {
      return { raw: item, envelope: null };
    }
    // Phase 4.5 Finding C audit: unlike dave_owned above, the external
    // owner is NOT always the sender -- an email can report a THIRD
    // party's commitment ("Aki will handle it," sent by someone else),
    // so sender identity can't be trusted as authoritative the way it is
    // for dave_owned. This intentionally stays model-first with a
    // sender fallback (most external_owned emails are self-referential:
    // "I'll send Dave X"), rather than flipping to sender-first.
    const actorEmail = item.externalActorEmail?.trim() || input.senderEmail;
    const resolution = actorEmail ? await resolveMemoryEntityByEmail(actorEmail) : null;
    const actor: ActorRef = resolution
      ? { entityId: resolution.entityId, email: actorEmail ?? null, name: resolution.canonicalName }
      : { entityId: null, email: actorEmail ?? null, name: null };

    if (!actor.entityId) {
      return { raw: item, envelope: null };
    }

    return {
      raw: item,
      envelope: {
        occurredAt,
        actors: [actor, senderActor],
        excerpt,
        candidateTitle: item.actionTitle?.trim() || null,
        ownership: { owner: "external", actor, basis: item.ownershipBasis as OwnershipBasis, excerpt },
        timing,
        projectHint: null,
        completion: null,
        cancellation: null,
      },
    };
  }

  if (item.kind === "completion" || item.kind === "cancellation") {
    if (!excerpt) {
      return { raw: item, envelope: null };
    }
    return {
      raw: item,
      envelope: {
        occurredAt,
        actors: [senderActor],
        excerpt,
        candidateTitle: item.actionTitle?.trim() || null,
        ownership: { owner: "ambiguous" },
        timing: null,
        projectHint: null,
        completion: item.kind === "completion" ? { likely: true, basis: "email", excerpt } : null,
        cancellation: item.kind === "cancellation" ? { likely: true, basis: "email", excerpt } : null,
      },
    };
  }

  return { raw: item, envelope: null };
}
