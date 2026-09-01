import "server-only";

import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";

import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { supabaseServer } from "@/lib/supabase/server";
import { findCollapsibleExistingClaim } from "@/lib/memory/claimReconciliation";
import { assessClaimReviewTier } from "@/lib/memory/claimReviewPolicy";
import { extractTeamsOperationalEvidence, type TeamsBatchMessage } from "@/lib/reconciliation/teamsEvidence";
import { reconcileEnvelope } from "@/lib/reconciliation/reconcileEnvelope";
import { findOpenItemsContext } from "@/lib/reconciliation/matchCandidates";
import { completeReconciliationRun, emptyCounters, recordReconciliationDecision, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { ActorRef, ReconciliationTrigger } from "@/lib/reconciliation/types";

const TEAMS_BATCH_PROCESSOR_VERSION = 1;
const TEAMS_SOURCE_INGESTION_VERSION = 1;
const MAX_MESSAGES_PER_BATCH = 200;
const DAVE_EMAIL = "dmerry@suffolk.edu";

const CLAIM_TYPES = new Set([
  "fact", "role", "responsibility", "relationship", "project_association",
  "decision", "status", "milestone", "preference", "governing_context",
  "working_context", "other",
]);

const PENDING_TYPES = new Set([
  "follow_up", "waiting_on", "deferred_idea", "future_trigger", "tweak",
  "gift_idea", "performance_note", "reminder_context", "other",
]);

const EVIDENCE_STRENGTHS = new Set(["weak", "moderate", "strong"]);

type TeamsMessageRow = {
  message_id: string;
  chat_id: string;
  message_type: string | null;
  sender_user_id: string | null;
  sender_display_name: string | null;
  created_at: string;
  last_modified_at: string | null;
  body_text: string | null;
};

type ExtractedClaim = {
  entityName?: string;
  claimType?: string;
  statement?: string;
  evidenceStrength?: string;
  supportingMessageIndexes?: number[];
};

type ExtractedPendingContext = {
  entityName?: string;
  contextType?: string;
  summary?: string;
  detail?: string;
  supportingMessageIndexes?: number[];
};

type ExtractionResult = {
  claims?: ExtractedClaim[];
  pendingContext?: ExtractedPendingContext[];
};

function redactSensitiveContent(text: string) {
  return text
    .replace(/((?:password|passwd|passcode|pwd|pw)\s*[:=]\s*)([^\s<;]+)/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*)([^\s<;]+)/gi, "$1[REDACTED]");
}

function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function parseJsonObject(text: string): ExtractionResult {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as ExtractionResult;
  } catch {
    // Continue.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];

  if (fenced) {
    try {
      return JSON.parse(fenced.trim()) as ExtractionResult;
    } catch {
      // Continue.
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as ExtractionResult;
  }

  throw new Error(`Could not parse Teams Memory extraction JSON: ${text}`);
}

type ChatFamily = {
  id: string;
  metadata: {
    chat_id?: string;
    teams_processor_version?: number;
    last_processed_message_id?: string;
    last_processed_message_at?: string;
    last_processed_edit_at?: string;
    last_sync_processed_at?: string;
  };
};

async function findOrCreateChatFamily(chatId: string, firstSeenAt: string): Promise<ChatFamily> {
  const { data: existing, error: existingError } = await supabaseServer
    .from("memory_source_families")
    .select("id, metadata")
    .eq("family_type", "teams_conversation")
    .eq("metadata->>chat_id", chatId)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Could not look up Teams chat family: ${existingError.message}`);
  }

  if (existing) {
    return {
      id: existing.id,
      metadata: (existing.metadata ?? {}) as ChatFamily["metadata"],
    };
  }

  const { data: created, error: createError } = await supabaseServer
    .from("memory_source_families")
    .insert({
      family_type: "teams_conversation",
      name: `Teams chat ${chatId}`,
      occurred_at: firstSeenAt,
      metadata: { chat_id: chatId },
    })
    .select("id, metadata")
    .single();

  if (createError || !created) {
    throw new Error(`Could not create Teams chat family: ${createError?.message ?? "Unknown error"}`);
  }

  return { id: created.id, metadata: (created.metadata ?? {}) as ChatFamily["metadata"] };
}

type MessageSourceState = {
  sourceId: string;
  wasEdited: boolean;
};

async function findOrCreateMessageSource(
  message: TeamsMessageRow,
  familyId: string,
  authorName: string
): Promise<MessageSourceState> {
  const content = redactSensitiveContent((message.body_text ?? "").trim());
  const contentFingerprint = fingerprint(content);

  const { data: existing, error: existingError } = await supabaseServer
    .from("memory_sources")
    .select("id, metadata")
    .eq("canonical_table", "teams_messages")
    .eq("canonical_record_id", message.message_id)
    .maybeSingle();

  if (existingError) {
    throw new Error(`Could not check Teams message Memory source: ${existingError.message}`);
  }

  if (!existing) {
    const { data: created, error: createError } = await supabaseServer
      .from("memory_sources")
      .insert({
        source_type: "other",
        source_family_id: familyId,
        title: `Teams message from ${authorName}`,
        canonical_table: "teams_messages",
        canonical_record_id: message.message_id,
        content_text: content.slice(0, 2000),
        author_name: authorName,
        source_at: message.created_at,
        metadata: {
          chat_id: message.chat_id,
          message_type: message.message_type,
          content_fingerprint: contentFingerprint,
          teams_processor_version: TEAMS_SOURCE_INGESTION_VERSION,
        },
      })
      .select("id")
      .single();

    if (createError || !created) {
      throw new Error(`Could not create Teams message Memory source: ${createError?.message ?? "Unknown error"}`);
    }

    return { sourceId: created.id, wasEdited: false };
  }

  const priorMetadata = (existing.metadata ?? {}) as Record<string, unknown>;
  const priorFingerprint = typeof priorMetadata.content_fingerprint === "string"
    ? priorMetadata.content_fingerprint
    : null;
  const wasEdited = priorFingerprint !== null && priorFingerprint !== contentFingerprint;

  if (wasEdited || !priorFingerprint) {
    const { error: updateError } = await supabaseServer
      .from("memory_sources")
      .update({
        content_text: content.slice(0, 2000),
        metadata: {
          ...priorMetadata,
          chat_id: message.chat_id,
          message_type: message.message_type,
          content_fingerprint: contentFingerprint,
          teams_processor_version: TEAMS_SOURCE_INGESTION_VERSION,
        },
      })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(`Could not update edited Teams message Memory source: ${updateError.message}`);
    }
  }

  return { sourceId: existing.id, wasEdited };
}

async function flagStaleClaimsForEditedMessage(sourceId: string, messageId: string) {
  const { data: staleEvidence, error: evidenceError } = await supabaseServer
    .from("memory_evidence")
    .select("id")
    .eq("source_id", sourceId);

  if (evidenceError) {
    throw new Error(`Could not check evidence for edited Teams message: ${evidenceError.message}`);
  }

  const evidenceIds = (staleEvidence ?? []).map((row) => row.id);

  if (evidenceIds.length === 0) {
    return;
  }

  const { data: affectedClaims, error: claimLinkError } = await supabaseServer
    .from("memory_claim_evidence")
    .select("claim_id")
    .in("evidence_id", evidenceIds);

  if (claimLinkError) {
    throw new Error(`Could not check claims linked to edited Teams message: ${claimLinkError.message}`);
  }

  const claimIds = [...new Set((affectedClaims ?? []).map((row) => row.claim_id))];

  for (const claimId of claimIds) {
    const { data: claim, error: claimError } = await supabaseServer
      .from("memory_claims")
      .select("id, statement, status")
      .eq("id", claimId)
      .maybeSingle();

    if (claimError) {
      throw new Error(`Could not load claim for edit reconciliation: ${claimError.message}`);
    }

    if (!claim || claim.status === "retracted") {
      continue;
    }

    const { error: reviewError } = await supabaseServer.from("memory_review_items").insert({
      review_type: "reconcile_edit",
      status: "pending",
      title: "Supporting Teams message was edited",
      prompt: `A message supporting this claim was edited after the fact:\n"${claim.statement}"`,
      claim_id: claim.id,
      priority: 45,
      payload: {
        options: ["Still accurate", "Outdated", "Dismiss"],
        generated_by: "teams_conversation_processing",
        source_type: "teams_message",
        message_id: messageId,
      },
    });

    if (reviewError) {
      throw new Error(`Could not create edit-reconciliation review item: ${reviewError.message}`);
    }
  }
}

export async function processTeamsConversationDelta(chatId: string, reconciliationTrigger: ReconciliationTrigger = "forward") {
  const { data: latest, error: latestError } = await supabaseServer
    .from("teams_messages")
    .select("created_at")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestError) {
    throw new Error(`Could not check Teams chat ${chatId}: ${latestError.message}`);
  }

  if (!latest) {
    return { processed: 0 as const, reason: "no_messages" as const };
  }

  const family = await findOrCreateChatFamily(chatId, latest.created_at);
  const sinceMessageAt = family.metadata.last_processed_message_at ?? "1970-01-01T00:00:00Z";
  const sinceEditAt = family.metadata.last_processed_edit_at ?? "1970-01-01T00:00:00Z";

  const { data: rows, error } = await supabaseServer
    .from("teams_messages")
    .select("message_id, chat_id, message_type, sender_user_id, sender_display_name, created_at, last_modified_at, body_text")
    .eq("chat_id", chatId)
    .or(`created_at.gt.${sinceMessageAt},last_modified_at.gt.${sinceEditAt}`)
    .not("body_text", "is", null)
    .order("created_at", { ascending: true })
    .limit(MAX_MESSAGES_PER_BATCH);

  if (error) {
    throw new Error(`Could not load Teams delta for chat ${chatId}: ${error.message}`);
  }

  const batch = (rows ?? []) as TeamsMessageRow[];

  if (batch.length === 0) {
    return { processed: 0 as const, reason: "no_new_messages" as const };
  }

  /*
   * 1. Resolve every distinct sender once.
   */
  const senderIds = [...new Set(batch.map((m) => m.sender_user_id).filter((id): id is string => Boolean(id)))];

  const { data: orgRows, error: orgError } = senderIds.length
    ? await supabaseServer.from("org_chart").select("employeeid, employeeemail, employee_upn").in("employeeid", senderIds)
    : { data: [], error: null };

  if (orgError) {
    throw new Error(`Could not resolve Teams senders in org chart: ${orgError.message}`);
  }

  const emailBySenderId = new Map<string, string>();

  for (const row of orgRows ?? []) {
    const email = row.employeeemail ?? row.employee_upn;
    if (row.employeeid && email) {
      emailBySenderId.set(row.employeeid, email);
    }
  }

  const resolutionBySenderId = new Map<string, Awaited<ReturnType<typeof resolveMemoryEntityByEmail>>>();

  for (const senderId of senderIds) {
    const email = emailBySenderId.get(senderId);
    resolutionBySenderId.set(senderId, email ? await resolveMemoryEntityByEmail(email) : null);
  }

  /*
   * 2. Known participants = resolved senders in this batch, excluding Dave.
   * Claims/pending context may only be attached to these entities.
   */
  const participants = new Map<string, { entityId: string; canonicalName: string }>();

  for (const [senderId, resolution] of resolutionBySenderId) {
    if (!resolution) continue;
    const email = emailBySenderId.get(senderId)?.toLowerCase();
    if (email === DAVE_EMAIL) continue;
    participants.set(resolution.canonicalName.toLowerCase(), {
      entityId: resolution.entityId,
      canonicalName: resolution.canonicalName,
    });
  }

  /*
   * 3. Create/update a Memory source per message so every message stays
   * individually provenance-addressable, and detect edits that may
   * invalidate previously-supported claims.
   */
  const sourceByMessageId = new Map<string, MessageSourceState>();

  for (const message of batch) {
    const senderId = message.sender_user_id;
    const resolution = senderId ? resolutionBySenderId.get(senderId) : null;
    const authorName = resolution?.canonicalName ?? message.sender_display_name ?? "Unknown participant";

    const state = await findOrCreateMessageSource(message, family.id, authorName);
    sourceByMessageId.set(message.message_id, state);

    if (state.wasEdited) {
      await flagStaleClaimsForEditedMessage(state.sourceId, message.message_id);
    }
  }

  const advanceFamilyMark = async (extra: Record<string, unknown> = {}) => {
    const lastMessage = batch[batch.length - 1];
    const maxEditAt = batch.reduce(
      (max, m) => (m.last_modified_at && m.last_modified_at > max ? m.last_modified_at : max),
      sinceEditAt
    );

    const { error: familyUpdateError } = await supabaseServer
      .from("memory_source_families")
      .update({
        metadata: {
          ...family.metadata,
          chat_id: chatId,
          teams_processor_version: TEAMS_BATCH_PROCESSOR_VERSION,
          last_processed_message_id: lastMessage.message_id,
          last_processed_message_at: lastMessage.created_at,
          last_processed_edit_at: maxEditAt,
          last_sync_processed_at: new Date().toISOString(),
          ...extra,
        },
      })
      .eq("id", family.id);

    if (familyUpdateError) {
      throw new Error(`Could not advance Teams chat high-water mark: ${familyUpdateError.message}`);
    }
  };

  if (participants.size === 0) {
    /*
     * No known counterpart in this batch (e.g. only Dave, or only
     * unresolved external senders) — nothing to reason about yet.
     */
    await advanceFamilyMark({ last_batch_result: "skipped_no_known_participants" });
    return { processed: batch.length, claimsCreated: 0, pendingCreated: 0, skipped: true as const };
  }

  /*
   * 4. One Claude call over the whole ordered batch.
   */
  const transcript = batch
    .map((message, index) => {
      const senderId = message.sender_user_id;
      const resolution = senderId ? resolutionBySenderId.get(senderId) : null;
      const speaker = resolution?.canonicalName ?? message.sender_display_name ?? "Unknown";
      const content = redactSensitiveContent((message.body_text ?? "").trim());
      return `[${index + 1}] (${message.created_at}) ${speaker}: ${content}`;
    })
    .join("\n");

  const participantNames = [...participants.values()].map((p) => p.canonicalName);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1200,
    system: `You extract only high-value persistent context for Dave Merry's personal AI Chief of Staff from a batch of Teams messages.

This is a bounded conversational batch, not a single message. Reason over the whole batch: several messages may collectively establish one decision or one commitment. Do not produce one output per message.

Ask: "What is now different because this conversation happened?" Good signals: a decision was made, a commitment was made, ownership changed, a deadline became meaningful, a blocker appeared or disappeared, something previously expected is no longer true, Dave is now waiting on someone/something, a previous pending item appears resolved.

Claims and pending-context items may ONLY be attached to these known participants (use the name exactly as given): ${participantNames.join(", ")}.
Do not attach anything to Dave Merry himself, and do not invent a participant not in that list.

STRICT VOLUME RULE:
- Maximum 3 claims total.
- Maximum 2 pending-context items total.
- Prefer fewer. Consolidate related messages into one output.
- Return zero items unless genuinely worth remembering. Most batches should produce nothing.

Do not create claims from greetings, routine logistics, banter, links without explanation, one-time actions presented as permanent ownership, or speculation.

Every claim and pending-context item MUST cite which numbered messages support it via supportingMessageIndexes (the [n] labels in the transcript).

CLAIM TYPES: fact, role, responsibility, relationship, project_association, decision, status, milestone, preference, governing_context, working_context, other.
PENDING CONTEXT TYPES: follow_up, waiting_on, deferred_idea, future_trigger, tweak, gift_idea, performance_note, reminder_context, other.

SECURITY RULE: never extract or reproduce passwords, API keys, tokens, secrets, or similar credentials.

Return JSON only:
{
  "claims": [{"entityName":"...","claimType":"...","statement":"...","evidenceStrength":"weak|moderate|strong","supportingMessageIndexes":[1,2]}],
  "pendingContext": [{"entityName":"...","contextType":"...","summary":"...","detail":"...","supportingMessageIndexes":[3]}]
}`,
    messages: [
      {
        role: "user",
        content: `Teams chat transcript (chat_id: ${chatId}):\n\n${transcript}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const extracted = textBlock?.type === "text" ? parseJsonObject(textBlock.text) : {};

  const claims = (extracted.claims ?? [])
    .filter((c) => c.statement?.trim() && c.entityName)
    .filter((c) => participants.has((c.entityName ?? "").toLowerCase()))
    .slice(0, 3);

  const pendingItems = (extracted.pendingContext ?? [])
    .filter((p) => p.summary?.trim() && p.entityName)
    .filter((p) => participants.has((p.entityName ?? "").toLowerCase()))
    .slice(0, 2);

  const evidenceIdByMessageIndex = new Map<number, string>();

  async function evidenceForIndexes(indexes: number[] | undefined, subjectEntityId: string) {
    const ids: string[] = [];

    for (const index of indexes ?? []) {
      const message = batch[index - 1];
      if (!message) continue;

      let evidenceId = evidenceIdByMessageIndex.get(index);

      if (!evidenceId) {
        const sourceState = sourceByMessageId.get(message.message_id);
        if (!sourceState) continue;

        const { data: evidence, error: evidenceError } = await supabaseServer
          .from("memory_evidence")
          .insert({
            source_id: sourceState.sourceId,
            evidence_type: "excerpt",
            content: redactSensitiveContent((message.body_text ?? "").trim()),
            effective_from: message.created_at,
            visibility: "normal",
            extracted_by: "ai",
            metadata: {
              extraction_type: "claim_candidate",
              source_type: "teams_message",
              ingestion_version: TEAMS_BATCH_PROCESSOR_VERSION,
            },
          })
          .select("id")
          .single();

        if (evidenceError || !evidence) {
          throw new Error(`Could not create Teams Memory evidence: ${evidenceError?.message ?? "Unknown error"}`);
        }

        evidenceId = evidence.id as string;
        evidenceIdByMessageIndex.set(index, evidenceId);
      }

      const { data: existingLink, error: existingLinkError } = await supabaseServer
        .from("memory_evidence_entities")
        .select("evidence_id")
        .eq("evidence_id", evidenceId)
        .eq("entity_id", subjectEntityId)
        .eq("relationship", "subject")
        .maybeSingle();

      if (existingLinkError) {
        throw new Error(`Could not check Teams evidence-entity link: ${existingLinkError.message}`);
      }

      if (!existingLink) {
        const { error: evidenceEntityError } = await supabaseServer
          .from("memory_evidence_entities")
          .insert({ evidence_id: evidenceId, entity_id: subjectEntityId, relationship: "subject" });

        if (evidenceEntityError) {
          throw new Error(`Could not connect Teams evidence to entity: ${evidenceEntityError.message}`);
        }
      }

      ids.push(evidenceId);
    }

    return ids;
  }

  for (const claim of claims) {
    const participant = participants.get((claim.entityName ?? "").toLowerCase())!;
    const claimType = CLAIM_TYPES.has(claim.claimType ?? "") ? claim.claimType! : "other";
    const evidenceStrength = EVIDENCE_STRENGTHS.has(claim.evidenceStrength ?? "") ? claim.evidenceStrength! : "weak";
    const statement = claim.statement!.trim();

    const evidenceIds = await evidenceForIndexes(claim.supportingMessageIndexes, participant.entityId);

    if (evidenceIds.length === 0) {
      continue;
    }

    /*
     * Deterministic duplicate pre-check -- see the matching block in
     * processPastCalendarEvent.ts. A Teams discussion frequently restates
     * a decision Memory already captured from the calendar event or the
     * follow-up email; without this the same proposition reached Dave's
     * review queue once per source.
     */
    const collapsible = await findCollapsibleExistingClaim(participant.entityId, statement);

    if (collapsible) {
      const { error: attachError } = await supabaseServer
        .from("memory_claim_evidence")
        .upsert(
          evidenceIds.map((evidenceId) => ({
            claim_id: collapsible.claim.id,
            evidence_id: evidenceId,
            relationship: "supports",
          })),
          { onConflict: "claim_id,evidence_id", ignoreDuplicates: true },
        );

      if (attachError) {
        throw new Error(`Could not attach Teams evidence to existing claim: ${attachError.message}`);
      }

      continue;
    }

    const reviewTier = assessClaimReviewTier({
      claimType,
      statement,
      evidenceStrength: evidenceStrength as "weak" | "moderate" | "strong" | "confirmed",
      relationship: "new",
      existingClaim: null,
    });

    const { data: newClaim, error: claimError } = await supabaseServer
      .from("memory_claims")
      .insert({
        claim_type: claimType,
        statement,
        status: "candidate",
        learned_at: new Date().toISOString(),
        evidence_strength: evidenceStrength,
        promotion_basis: "ai_extraction",
        confirmed_by_user: false,
        visibility: "normal",
        created_by: "ai",
        metadata: {
          source_type: "teams_conversation",
          chat_id: chatId,
          ingestion_version: TEAMS_BATCH_PROCESSOR_VERSION,
          risk_tier: reviewTier.tier,
          risk_tier_reason: reviewTier.reason,
          auto_saved: reviewTier.tier === "auto_save",
        },
      })
      .select("id")
      .single();

    if (claimError || !newClaim) {
      throw new Error(`Could not create Teams Memory claim: ${claimError?.message ?? "Unknown error"}`);
    }

    const { error: claimEntityError } = await supabaseServer
      .from("memory_claim_entities")
      .insert({ claim_id: newClaim.id, entity_id: participant.entityId, role: "subject" });

    if (claimEntityError) {
      throw new Error(`Could not connect Teams claim to entity: ${claimEntityError.message}`);
    }

    const { error: claimEvidenceError } = await supabaseServer
      .from("memory_claim_evidence")
      .insert(evidenceIds.map((evidenceId) => ({ claim_id: newClaim.id, evidence_id: evidenceId, relationship: "supports" })));

    if (claimEvidenceError) {
      throw new Error(`Could not connect Teams claim to evidence: ${claimEvidenceError.message}`);
    }

    if (reviewTier.tier !== "auto_save") {
      const { error: reviewError } = await supabaseServer.from("memory_review_items").insert({
        review_type: "confirm_claim",
        status: "pending",
        title: "Review extracted Memory",
        prompt: statement,
        claim_id: newClaim.id,
        entity_id: participant.entityId,
        priority: 40,
        payload: {
          options: ["Confirm", "Outdated", "Keep as evidence", "Not sure", "Dismiss"],
          generated_by: "teams_conversation_processing",
          ingestion_version: TEAMS_BATCH_PROCESSOR_VERSION,
          source_type: "teams_conversation",
          chat_id: chatId,
          risk_tier_reason: reviewTier.reason,
        },
      });

      if (reviewError) {
        throw new Error(`Could not create Teams Memory claim review item: ${reviewError.message}`);
      }
    }
  }

  for (const pending of pendingItems) {
    const participant = participants.get((pending.entityName ?? "").toLowerCase())!;
    const contextType = PENDING_TYPES.has(pending.contextType ?? "") ? pending.contextType! : "other";
    const summary = pending.summary!.trim();
    const detail = pending.detail?.trim() || null;

    await evidenceForIndexes(pending.supportingMessageIndexes, participant.entityId);

    const firstSupportingIndex = pending.supportingMessageIndexes?.[0];
    const firstSupportingMessage = firstSupportingIndex ? batch[firstSupportingIndex - 1] : undefined;
    const pendingSourceId = firstSupportingMessage
      ? sourceByMessageId.get(firstSupportingMessage.message_id)?.sourceId
      : undefined;

    const { data: pendingRow, error: pendingError } = await supabaseServer
      .from("memory_pending_context")
      .insert({
        context_type: contextType,
        summary,
        detail,
        status: "pending",
        trigger_type: "manual",
        primary_entity_id: participant.entityId,
        source_id: pendingSourceId,
        visibility: "normal",
        created_by: "ai",
        metadata: {
          generated_by: "teams_conversation_processing",
          ingestion_version: TEAMS_BATCH_PROCESSOR_VERSION,
          chat_id: chatId,
        },
      })
      .select("id")
      .single();

    if (pendingError || !pendingRow) {
      throw new Error(`Could not create Teams pending Memory context: ${pendingError?.message ?? "Unknown error"}`);
    }

    const { error: reviewError } = await supabaseServer.from("memory_review_items").insert({
      review_type: "pending_context",
      status: "pending",
      title: summary,
      prompt: detail ?? `From Teams conversation`,
      entity_id: participant.entityId,
      pending_context_id: pendingRow.id,
      priority: 35,
      payload: {
        options: ["Follow up", "Keep waiting", "Resolved", "Dismiss"],
        generated_by: "teams_conversation_processing",
        ingestion_version: TEAMS_BATCH_PROCESSOR_VERSION,
        source_type: "teams_conversation",
        chat_id: chatId,
      },
    });

    if (reviewError) {
      throw new Error(`Could not create Teams pending Memory review item: ${reviewError.message}`);
    }
  }

  await advanceFamilyMark({
    last_batch_result: "processed",
    last_batch_claims_created: claims.length,
    last_batch_pending_created: pendingItems.length,
  });

  /*
   * 5. Action Reconciliation -- operational evidence.
   *
   * A separate, additional model call over the SAME batch/transcript
   * context already assembled above (including Dave's own messages,
   * which the participants map above deliberately excludes for Memory's
   * claims/pending purposes but which remain visible here) -- so a
   * failure or future change here can never affect Memory's
   * claims/pending-context behavior. Reasons over the whole delta batch,
   * not per-message, matching processTeamsConversationDelta's own
   * "what changed because this conversation happened" model.
   *
   * Nested try/catch mirrors the Phase 3 email fix exactly: an inner
   * failure marks the run "failed" (never leaves it stuck in_progress);
   * an outer failure (e.g. the run couldn't even be started) is only
   * logged. Either way this step can never affect the return contract
   * above or Memory's already-completed, already-returned work.
   */
  try {
    const { runId, traceId: reconciliationTraceId } = await startReconciliationRun({
      trigger: reconciliationTrigger,
      sourceType: "teams_conversation",
      sourceId: chatId,
      summary: `Reconcile Teams conversation delta: chat ${chatId}`,
      metadata: { chatId, familyId: family.id, batchSize: batch.length },
    });
    const counters = emptyCounters();

    try {
      const emailByEntityId = new Map<string, string>();
      for (const [senderId, resolution] of resolutionBySenderId) {
        if (resolution) {
          emailByEntityId.set(resolution.entityId, emailBySenderId.get(senderId) ?? "");
        }
      }
      const actorParticipants = new Map<string, ActorRef>(
        [...participants.entries()].map(([name, p]) => [
          name,
          { entityId: p.entityId, email: emailByEntityId.get(p.entityId) ?? null, name: p.canonicalName },
        ])
      );

      // Resolved once for deterministic speaker-identity comparison
      // (Phase 4.5 Finding C) -- distinguishing "Dave said this" from
      // "a known participant said this" by entity id, not name string.
      const daveResolution = await resolveMemoryEntityByEmail(DAVE_EMAIL);

      const teamsBatch: TeamsBatchMessage[] = batch.map((message, index) => {
        const senderId = message.sender_user_id;
        const resolution = senderId ? resolutionBySenderId.get(senderId) : null;
        const isDave = Boolean(resolution && daveResolution && resolution.entityId === daveResolution.entityId);
        const speakerActor: ActorRef | null = resolution
          ? { entityId: resolution.entityId, email: senderId ? emailBySenderId.get(senderId) ?? null : null, name: resolution.canonicalName }
          : null;
        return {
          index: index + 1,
          messageId: message.message_id,
          createdAt: message.created_at,
          speakerName: resolution?.canonicalName ?? message.sender_display_name ?? "Unknown",
          speakerActor,
          isDave,
          content: redactSensitiveContent((message.body_text ?? "").trim()),
        };
      });

      // Phase 4.5 Finding B: bounded context of currently-open items
      // plausibly related to this chat, so a later delta lacking the
      // original commitment can still be interpreted. Failure here
      // degrades to "no context" rather than failing the whole step --
      // it's a helpful hint, not load-bearing.
      let openItems: Awaited<ReturnType<typeof findOpenItemsContext>> = [];
      try {
        openItems = await findOpenItemsContext({
          chatId,
          actorEntityIds: [...actorParticipants.values()].map((a) => a.entityId).filter((id): id is string => Boolean(id)),
        });
      } catch (contextError) {
        console.error("Could not load open-item context for Teams chat", chatId, contextError);
      }

      const classified = await extractTeamsOperationalEvidence({
        chatId,
        batch: teamsBatch,
        participants: actorParticipants,
        openItems,
      });
      counters.evidenceConsidered = classified.length;

      for (const { raw, envelope } of classified) {
        if (!envelope) {
          counters.itemsIgnored += 1;
          await recordReconciliationDecision(reconciliationTraceId, {
            runId,
            evidenceRef: { chatId, kind: raw.kind ?? "none", supportingMessageIndexes: raw.supportingMessageIndexes ?? [] },
            outcome: "no_action",
            automatic: true,
            reasoningSummary:
              raw.kind && raw.kind !== "none"
                ? `Classified as "${raw.kind}" but missing a required field (valid ownership basis, resolvable counterpart, or supporting message indexes); no action taken.`
                : "No ownership, completion, or cancellation evidence cleared the bar for operational action.",
          });
          continue;
        }

        const messageIds = (envelope.metadata?.messageIds as string[] | undefined) ?? [];
        const anchorMessageId = messageIds[0] ?? teamsBatch[0]?.messageId;
        const fullEnvelope = {
          ...envelope,
          sourceType: "teams_message" as const,
          sourceLocator: { teams_message_id: anchorMessageId, chat_id: chatId },
        };
        const result = await reconcileEnvelope({ envelope: fullEnvelope, runId, traceId: reconciliationTraceId });
        if (result.outcome === "create_dave_item" || result.outcome === "create_external_item") {
          counters.itemsCreated += 1;
        } else if (result.executionItemId) {
          counters.itemsMatched += 1;
        } else {
          counters.itemsIgnored += 1;
        }
      }

      await completeReconciliationRun(runId, reconciliationTraceId, {
        status: "completed",
        counters,
        summary: `Teams conversation reconciled: ${counters.itemsCreated} created, ${counters.itemsMatched} matched, ${counters.itemsIgnored} ignored`,
      });
    } catch (innerError) {
      counters.errors += 1;
      await completeReconciliationRun(runId, reconciliationTraceId, {
        status: "failed",
        counters,
        summary: innerError instanceof Error ? innerError.message : "Unknown error",
      });
      throw innerError;
    }
  } catch (reconciliationError) {
    console.error("Action reconciliation failed for Teams chat", chatId, reconciliationError);
  }

  return {
    processed: batch.length,
    claimsCreated: claims.length,
    pendingCreated: pendingItems.length,
  };
}
