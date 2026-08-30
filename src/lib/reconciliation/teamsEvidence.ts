import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { isDaveOwnershipBasis, isExternalOwnershipBasis } from "./ownershipRules";
import { deterministicCounterpart } from "./teamsIdentity";
import type { ActionEvidenceEnvelope, ActorRef, OwnershipBasis } from "./types";
import type { OpenItemContext } from "./matchCandidates";

const MODEL_NAME = "claude-sonnet-4-5-20250929";

export type TeamsBatchMessage = {
  index: number;
  messageId: string;
  createdAt: string;
  speakerName: string;
  /** Resolved Memory identity of the speaker, or null if unresolved. Used for deterministic counterpart derivation (Phase 4.5 Finding C) -- source-author identity beats model-generated identity. */
  speakerActor: ActorRef | null;
  isDave: boolean;
  content: string;
};

type RawOperationalEvidence = {
  kind?: string;
  actionTitle?: string | null;
  ownershipBasis?: string | null;
  counterpartName?: string | null;
  supportingMessageIndexes?: number[];
  relatedItemId?: string | null;
  dueAt?: string | null;
  timingBasis?: string | null;
};

function parseJson(raw: string): { operationalEvidence?: RawOperationalEvidence[] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

export type ClassifiedTeamsEvidence = {
  raw: RawOperationalEvidence;
  envelope: Omit<ActionEvidenceEnvelope, "sourceType" | "sourceLocator"> | null;
};

/**
 * Extracts operational (Execute-relevant) evidence from one bounded Teams
 * conversation delta batch -- the SAME batch processTeamsConversationDelta.ts
 * already assembled for its own Memory extraction, reused here rather than
 * re-fetched, so this call reasons over identical conversational context
 * (including Dave's own messages, which Memory's claims/pending pass
 * excludes from its "known participants" set but which are present in the
 * transcript). A separate, additional model call -- Memory's existing
 * behavior is untouched (Brief Part 8/Phase 3 precedent: "Keep Memory
 * extraction unchanged").
 *
 * Reasons over the WHOLE batch, not per-message (Brief Part 4.2/4.3): an
 * obligation may be established across several messages ("Sarah: can
 * someone revise the draft? / Dave: I can do it. / Sarah: by Friday?").
 *
 * `openItems` (Phase 4.5 Finding B) is a small, pre-vetted, bounded list of
 * currently-open items plausibly related to this chat -- supplied purely
 * as context to help the model recognize later deltas ("Wednesday
 * instead") that lack the original commitment in the current batch. The
 * model may point at one via `relatedItemId`, but that's only ever
 * treated as a candidate reference here: we deterministically borrow that
 * item's OWN title/counterpart (never anything the model invents) to feed
 * the same title-similarity scoring reconcileEnvelope already runs on
 * every envelope -- the actual attach/create/review decision is entirely
 * unaffected by this hint's presence.
 */
export async function extractTeamsOperationalEvidence(input: {
  chatId: string;
  batch: TeamsBatchMessage[];
  participants: Map<string, ActorRef>;
  openItems?: OpenItemContext[];
}): Promise<ClassifiedTeamsEvidence[]> {
  if (input.batch.length === 0) return [];

  const transcript = input.batch.map((m) => `[${m.index}] (${m.createdAt}) ${m.speakerName}: ${m.content}`).join("\n");
  const participantNames = [...input.participants.values()].map((actor) => actor.name).filter(Boolean);
  const openItems = input.openItems ?? [];

  const contextBlock =
    openItems.length > 0
      ? `\n\nCurrently open related work (context only -- reference by id via relatedItemId if a message clearly continues one of these; otherwise ignore):\n${openItems
          .map((item) => `- ${item.id}: ${item.responsibility === "mine" ? "Dave" : item.counterpartName ?? "external"} -- ${item.title}${item.timingAt ? ` -- due ${item.timingAt}` : ""}`)
          .join("\n")}`
      : "";

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODEL_NAME,
    max_tokens: 1200,
    system: `Identify operational work signals in a bounded Teams conversation batch for Dave Merry's AI Chief of Staff Action Reconciliation layer. This is a conversational batch, not a single message -- several messages may collectively establish one commitment. Do not produce one output per message.

CHECK FIRST, before deciding a batch has nothing to report: does it contain any of these?
1. Dave is directly addressed and asked, instructed, or assigned to do something. -> kind "dave_owned", ownershipBasis "explicit_assignment_to_dave".
2. Dave states he will do something, or explicitly agrees to a prior ask (his own words, possibly across several messages). -> kind "dave_owned", ownershipBasis "explicit_acceptance_by_dave" or "explicit_user_intent".
3. Someone else, speaking about themselves, commits to doing or sending something -- often naming Dave as recipient. -> kind "external_owned", ownershipBasis "explicit_external_commitment".
4. The batch expresses thanks, confirmation, or acknowledgment that something Dave (or the counterpart) was expected to deliver has arrived or is done -- including when this only makes sense in light of the "Currently open related work" list below. -> kind "completion".
5. The batch says a commitment involving Dave no longer applies, changed hands, or was superseded -- including a bare timing change like "Wednesday instead" IF it clearly continues an item in the open-work list below. -> kind "cancellation" for ownership changes, or re-report as "dave_owned"/"external_owned" with the new dueAt for a pure timing change.
If NONE of these clearly applies -- vague suggestions, someone else's task, an unresolved "can somebody...", broad discussion -- do not return an item. Never infer Dave ownership from group addressing, importance, or passive voice. Uncertain ownership means no item.

Worked examples (all of these ARE reportable):
- Dave: "Yep, I'll send that tomorrow." -> dave_owned / explicit_acceptance_by_dave (or explicit_user_intent if unprompted).
- Sarah: "Dave will revise the requirements." / Dave: "Yes." -> dave_owned / explicit_acceptance_by_dave (cite both messages).
- "Dave, could you review this before Friday?" -> dave_owned / explicit_assignment_to_dave, ONLY if Dave is the addressee, not a group.
- Aki: "I'll send Dave the security requirements Tuesday." -> external_owned / explicit_external_commitment. NOT a Dave task.
- "Actually, let's make that Wednesday instead." (clearly continuing an earlier obligation, in-batch OR from the open-work list) -> the SAME obligation with updated dueAt, not a new item.
- "Aki is going to handle that instead of Dave." -> cancellation.
- "Thanks, Dave -- got the revised version." -> completion.
- "We should probably revisit the website someday." -> omit entirely.
- "Can somebody take this?" with no acceptance anywhere in the batch -> omit entirely. If Dave later accepts in the same batch, that IS dave_owned.

Known participants (use a name EXACTLY as given here for counterpartName, or omit it): ${participantNames.join(", ") || "(none resolved)"}. counterpartName is a fallback only -- prefer leaving it null when the relevant speaker is already unambiguous from the transcript; the caller derives identity from message authorship where possible.${contextBlock}

Every item you return MUST include non-empty supportingMessageIndexes citing the [n] labels above. Return JSON only: {"operationalEvidence":[]}. At most 3 items.
Item shape: {"kind":"dave_owned|external_owned|completion|cancellation","actionTitle":"short standalone title","ownershipBasis":"explicit_assignment_to_dave|explicit_acceptance_by_dave|explicit_user_intent|explicit_external_commitment|explicit_external_assignment or null for completion/cancellation","counterpartName":"fallback only, or null","relatedItemId":"an id from the open-work list above if this clearly continues it, else null","supportingMessageIndexes":[1,2],"dueAt":"ISO date or null","timingBasis":"must|target or null"}.
SECURITY: Never reproduce credentials, secrets, passwords, or tokens.`,
    messages: [{ role: "user", content: `Teams chat transcript (chat_id: ${input.chatId}):\n\n${transcript}` }],
  });

  const block = response.content.find((item) => item.type === "text");
  const parsed = block?.type === "text" ? parseJson(block.text) : { operationalEvidence: [] };
  const items = (parsed.operationalEvidence ?? []).slice(0, 3);

  const openItemById = new Map(openItems.map((item) => [item.id, item]));

  return items.map((item) => classify(item, input, openItemById));
}

function classify(
  item: RawOperationalEvidence,
  input: { chatId: string; batch: TeamsBatchMessage[]; participants: Map<string, ActorRef> },
  openItemById: Map<string, OpenItemContext>
): ClassifiedTeamsEvidence {
  const indexes = (item.supportingMessageIndexes ?? []).filter((index) => input.batch.some((m) => m.index === index));
  if (indexes.length === 0) {
    return { raw: item, envelope: null };
  }

  const citedMessages = indexes.map((index) => input.batch.find((m) => m.index === index)!).sort((a, b) => a.index - b.index);
  const excerpt = citedMessages.map((m) => `${m.speakerName}: ${m.content}`).join(" / ").slice(0, 1500);
  const firstMessage = citedMessages[0];
  const occurredAt = firstMessage.createdAt;

  // Referenced item is a candidate reference only (Brief Finding B
  // constraint): never trust an id we didn't supply, and never let it
  // drive the outcome directly -- it only seeds title/counterpart inputs
  // that reconcileEnvelope's own matching then scores independently.
  const relatedItem = item.relatedItemId ? openItemById.get(item.relatedItemId) ?? null : null;

  const deterministic = deterministicCounterpart(item.kind ?? "", citedMessages);
  const modelNamed = item.counterpartName
    ? input.participants.get(item.counterpartName.trim().toLowerCase()) ?? null
    : null;
  const counterpart = deterministic ?? modelNamed;

  const candidateTitle = item.actionTitle?.trim() || relatedItem?.title || null;

  const timing =
    item.dueAt && !Number.isNaN(Date.parse(item.dueAt))
      ? { kind: (item.timingBasis === "must" ? "must" : "target") as "must" | "target", at: new Date(item.dueAt).toISOString(), basis: "teams" }
      : null;

  const baseEnvelope = {
    occurredAt,
    excerpt,
    candidateTitle,
    timing,
    projectHint: null,
    metadata: { chatId: input.chatId, messageIds: citedMessages.map((m) => m.messageId), relatedItemHint: item.relatedItemId ?? null },
  };

  if (item.kind === "dave_owned") {
    if (!isDaveOwnershipBasis(item.ownershipBasis)) {
      return { raw: item, envelope: null };
    }
    const actors: ActorRef[] = counterpart ? [counterpart] : [];
    return {
      raw: item,
      envelope: {
        ...baseEnvelope,
        actors,
        ownership: { owner: "dave", basis: item.ownershipBasis as OwnershipBasis, excerpt },
        completion: null,
        cancellation: null,
      },
    };
  }

  if (item.kind === "external_owned") {
    if (!isExternalOwnershipBasis(item.ownershipBasis) || !counterpart?.entityId) {
      return { raw: item, envelope: null };
    }
    return {
      raw: item,
      envelope: {
        ...baseEnvelope,
        actors: [counterpart],
        ownership: { owner: "external", actor: counterpart, basis: item.ownershipBasis as OwnershipBasis, excerpt },
        completion: null,
        cancellation: null,
      },
    };
  }

  if (item.kind === "completion" || item.kind === "cancellation") {
    const actors: ActorRef[] = counterpart ? [counterpart] : [];
    return {
      raw: item,
      envelope: {
        ...baseEnvelope,
        actors,
        ownership: { owner: "ambiguous" },
        completion: item.kind === "completion" ? { likely: true, basis: "teams", excerpt } : null,
        cancellation: item.kind === "cancellation" ? { likely: true, basis: "teams", excerpt } : null,
      },
    };
  }

  return { raw: item, envelope: null };
}
