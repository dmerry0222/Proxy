import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { supabaseServer } from "@/lib/supabase/server";
import {
  attendeeEmails,
  calendarEventFingerprint,
  findOrCreateCalendarEventSource,
  resolveAttendeeEntities,
  updateCalendarEventSourceMetadata,
  type CalendarEventRow,
} from "@/lib/memory/calendarEventSource";
import { reconcileCalendarEvent, type CalendarReconcileEvent } from "@/lib/reconciliation/calendarReconcile";
import { completeReconciliationRun, emptyCounters, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { ActorRef, ReconciliationTrigger } from "@/lib/reconciliation/types";
import { htmlToPlainText } from "@/lib/memory/htmlToPlainText";
import { findCollapsibleExistingClaim } from "@/lib/memory/claimReconciliation";
import { assessClaimReviewTier } from "@/lib/memory/claimReviewPolicy";

const CALENDAR_PROCESSOR_VERSION = 1;
const DAVE_EMAIL = "dmerry@suffolk.edu";
const REVISIT_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

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

type RelatedEvidenceItem = {
  text: string;
  retrievedFrom: "meeting_artifact" | "teams_message" | "email";
  occurredAt: string | null;
};

/*
 * Deterministic retrieval, in priority order, per the retrieval-order
 * design: explicit links first, then participants + narrow temporal
 * proximity. Semantic similarity is intentionally not attempted here.
 */
async function findRelatedEvidence(
  event: CalendarEventRow,
  attendeeEmailList: string[],
  since: string | null
): Promise<RelatedEvidenceItem[]> {
  const items: RelatedEvidenceItem[] = [];

  const { data: links, error: linksError } = await supabaseServer
    .from("meeting_calendar_links")
    .select("meeting_id")
    .eq("calendar_event_id", event.event_id);

  if (linksError) {
    throw new Error(`Could not check meeting_calendar_links: ${linksError.message}`);
  }

  const meetingIds = [...new Set((links ?? []).map((row) => row.meeting_id))];

  if (meetingIds.length > 0) {
    const { data: meetings, error: meetingsError } = await supabaseServer
      .from("meetings")
      .select("id, source_family_id")
      .in("id", meetingIds);

    if (meetingsError) {
      throw new Error(`Could not load linked meetings: ${meetingsError.message}`);
    }

    const familyIds = (meetings ?? [])
      .map((m) => m.source_family_id)
      .filter((id): id is string => Boolean(id));

    if (familyIds.length > 0) {
      const { data: sources, error: sourcesError } = await supabaseServer
        .from("memory_sources")
        .select("content_text, source_at, created_at")
        .in("source_family_id", familyIds)
        .not("content_text", "is", null);

      if (sourcesError) {
        throw new Error(`Could not load meeting artifact content: ${sourcesError.message}`);
      }

      for (const source of sources ?? []) {
        if (since && source.created_at && source.created_at <= since) continue;
        if (source.content_text?.trim()) {
          items.push({
            text: source.content_text.slice(0, 4000),
            retrievedFrom: "meeting_artifact",
            occurredAt: source.source_at,
          });
        }
      }
    }
  }

  if (attendeeEmailList.length > 0 && event.start_time && event.end_time) {
    const windowStart = new Date(new Date(event.start_time).getTime() - 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(new Date(event.end_time).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const { data: orgRows, error: orgError } = await supabaseServer
      .from("org_chart")
      .select("employeeid, employeeemail, employee_upn");

    if (orgError) {
      throw new Error(`Could not load org chart for Calendar reconciliation: ${orgError.message}`);
    }

    const emailSet = new Set(attendeeEmailList);
    const senderIds = (orgRows ?? [])
      .filter((row) => {
        const email = (row.employeeemail ?? row.employee_upn ?? "").toLowerCase();
        return email && emailSet.has(email);
      })
      .map((row) => row.employeeid)
      .filter((id): id is string => Boolean(id));

    if (senderIds.length > 0) {
      const { data: teamsRows, error: teamsError } = await supabaseServer
        .from("teams_messages")
        .select("body_text, created_at, sender_display_name")
        .in("sender_user_id", senderIds)
        .gte("created_at", windowStart)
        .lte("created_at", windowEnd)
        .not("body_text", "is", null)
        .order("created_at", { ascending: true })
        .limit(50);

      if (teamsError) {
        throw new Error(`Could not load nearby Teams messages: ${teamsError.message}`);
      }

      for (const row of teamsRows ?? []) {
        if (since && row.created_at && row.created_at <= since) continue;
        if (row.body_text?.trim()) {
          items.push({
            text: `${row.sender_display_name ?? "Unknown"}: ${row.body_text.trim()}`,
            retrievedFrom: "teams_message",
            occurredAt: row.created_at,
          });
        }
      }
    }

    const { data: emailRows, error: emailError } = await supabaseServer
      .from("emails")
      .select("subject, body_preview, message_at, from_email")
      .in("from_email", attendeeEmailList)
      .gte("message_at", windowStart)
      .lte("message_at", windowEnd)
      .order("message_at", { ascending: true })
      .limit(20);

    if (emailError) {
      throw new Error(`Could not load nearby emails: ${emailError.message}`);
    }

    for (const row of emailRows ?? []) {
      if (since && row.message_at && row.message_at <= since) continue;
      if (row.body_preview?.trim()) {
        items.push({
          text: `Email from ${row.from_email} (${row.subject ?? "no subject"}): ${row.body_preview.trim()}`,
          retrievedFrom: "email",
          occurredAt: row.message_at,
        });
      }
    }
  }

  return items;
}

type ExtractedClaim = {
  entityName?: string;
  claimType?: string;
  statement?: string;
  evidenceStrength?: string;
  supportingIndexes?: number[];
};

type ExtractedPendingContext = {
  entityName?: string;
  contextType?: string;
  summary?: string;
  detail?: string;
  supportingIndexes?: number[];
};

function parseJsonObject(text: string): { claims?: ExtractedClaim[]; pendingContext?: ExtractedPendingContext[] } {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    try {
      return JSON.parse(fenced.trim());
    } catch {
      // Continue.
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error(`Could not parse Calendar reconciliation JSON: ${text}`);
}

async function reconcileFromEvidence(
  event: CalendarEventRow,
  sourceId: string,
  attendees: { entityId: string; canonicalName: string; email: string }[],
  relatedEvidence: RelatedEvidenceItem[]
) {
  if (relatedEvidence.length === 0 || attendees.length === 0) {
    return { claimsCreated: 0, pendingCreated: 0 };
  }

  const labeled = relatedEvidence
    .map((item, index) => `[${index + 1}] (${item.occurredAt ?? "unknown time"}, ${item.retrievedFrom}) ${item.text}`)
    .join("\n\n")
    .slice(0, 8000);

  const attendeeNames = attendees.map((a) => a.canonicalName);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1200,
    system: `You reconcile what actually happened around a calendar meeting for Dave Merry's personal AI Chief of Staff, using related evidence gathered from meeting artifacts, nearby Teams messages, and nearby emails.

The calendar event itself only proves a meeting was scheduled. It does NOT prove the meeting occurred, that invitees attended, or that anything discussed became true. Only the supplied related evidence can support a claim.

Claims and pending-context items may ONLY be attached to these attendees (use the name exactly as given): ${attendeeNames.join(", ")}.
Do not attach anything to Dave Merry himself.

STRICT VOLUME RULE:
- Maximum 2 claims.
- Maximum 1 pending-context item.
- Return zero items unless the evidence genuinely supports something durable: a decision, a commitment, an ownership change, a status change, a resolved or new pending item.

Every claim and pending-context item MUST cite which numbered evidence excerpts support it via supportingIndexes.

CLAIM TYPES: fact, role, responsibility, relationship, project_association, decision, status, milestone, preference, governing_context, working_context, other.
PENDING CONTEXT TYPES: follow_up, waiting_on, deferred_idea, future_trigger, tweak, gift_idea, performance_note, reminder_context, other.

SECURITY RULE: never extract or reproduce passwords, API keys, tokens, secrets, or similar credentials.

Return JSON only:
{
  "claims": [{"entityName":"...","claimType":"...","statement":"...","evidenceStrength":"weak|moderate|strong","supportingIndexes":[1]}],
  "pendingContext": [{"entityName":"...","contextType":"...","summary":"...","detail":"...","supportingIndexes":[2]}]
}`,
    messages: [
      {
        role: "user",
        content: `Meeting: ${event.subject ?? "Untitled"}\nScheduled: ${event.start_time ?? "unknown"} - ${event.end_time ?? "unknown"}\n\nRelated evidence:\n\n${labeled}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const extracted = textBlock?.type === "text" ? parseJsonObject(textBlock.text) : {};

  const participants = new Map(attendees.map((a) => [a.canonicalName.toLowerCase(), a]));

  const claims = (extracted.claims ?? [])
    .filter((c) => c.statement?.trim() && c.entityName && participants.has(c.entityName.toLowerCase()))
    .slice(0, 2);

  const pendingItems = (extracted.pendingContext ?? [])
    .filter((p) => p.summary?.trim() && p.entityName && participants.has(p.entityName.toLowerCase()))
    .slice(0, 1);

  async function evidenceIdsFor(indexes: number[] | undefined, entityId: string) {
    const ids: string[] = [];

    for (const index of indexes ?? []) {
      const item = relatedEvidence[index - 1];
      if (!item) continue;

      const { data: evidence, error: evidenceError } = await supabaseServer
        .from("memory_evidence")
        .insert({
          source_id: sourceId,
          evidence_type: "excerpt",
          content: item.text.slice(0, 2000),
          effective_from: item.occurredAt,
          visibility: "normal",
          extracted_by: "ai",
          metadata: {
            extraction_type: "claim_candidate",
            source_type: "calendar_reconciliation",
            retrieved_from: item.retrievedFrom,
            calendar_processor_version: CALENDAR_PROCESSOR_VERSION,
          },
        })
        .select("id")
        .single();

      if (evidenceError || !evidence) {
        throw new Error(`Could not create Calendar reconciliation evidence: ${evidenceError?.message ?? "Unknown error"}`);
      }

      const { error: evidenceEntityError } = await supabaseServer
        .from("memory_evidence_entities")
        .insert({ evidence_id: evidence.id, entity_id: entityId, relationship: "subject" });

      if (evidenceEntityError) {
        throw new Error(`Could not connect Calendar evidence to entity: ${evidenceEntityError.message}`);
      }

      ids.push(evidence.id);
    }

    return ids;
  }

  let claimsCreated = 0;

  for (const claim of claims) {
    const participant = participants.get(claim.entityName!.toLowerCase())!;
    const evidenceIds = await evidenceIdsFor(claim.supportingIndexes, participant.entityId);
    if (evidenceIds.length === 0) continue;

    const claimType = CLAIM_TYPES.has(claim.claimType ?? "") ? claim.claimType! : "other";
    const evidenceStrength = EVIDENCE_STRENGTHS.has(claim.evidenceStrength ?? "") ? claim.evidenceStrength! : "weak";
    const statement = claim.statement!.trim();

    /*
     * Deterministic duplicate pre-check. This path used to insert a claim
     * and a review item unconditionally, so a fact Memory already held
     * from email or Teams arrived in Dave's queue a second time. On a
     * collapse-safe match we attach this event's evidence to the existing
     * claim and create nothing new -- the claim gets stronger, the queue
     * does not grow.
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
        throw new Error(`Could not attach Calendar evidence to existing claim: ${attachError.message}`);
      }

      continue;
    }

    /*
     * Same tiered review policy the email path uses. Previously this path
     * bypassed it entirely and created a review item for every claim
     * regardless of stakes.
     */
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
          source_type: "calendar_reconciliation",
          event_id: event.event_id,
          ingestion_version: CALENDAR_PROCESSOR_VERSION,
          risk_tier: reviewTier.tier,
          risk_tier_reason: reviewTier.reason,
          auto_saved: reviewTier.tier === "auto_save",
        },
      })
      .select("id")
      .single();

    if (claimError || !newClaim) {
      throw new Error(`Could not create Calendar reconciliation claim: ${claimError?.message ?? "Unknown error"}`);
    }

    const { error: claimEntityError } = await supabaseServer
      .from("memory_claim_entities")
      .insert({ claim_id: newClaim.id, entity_id: participant.entityId, role: "subject" });

    if (claimEntityError) {
      throw new Error(`Could not connect Calendar claim to entity: ${claimEntityError.message}`);
    }

    const { error: claimEvidenceError } = await supabaseServer
      .from("memory_claim_evidence")
      .insert(evidenceIds.map((evidenceId) => ({ claim_id: newClaim.id, evidence_id: evidenceId, relationship: "supports" })));

    if (claimEvidenceError) {
      throw new Error(`Could not connect Calendar claim to evidence: ${claimEvidenceError.message}`);
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
          generated_by: "calendar_reconciliation",
          ingestion_version: CALENDAR_PROCESSOR_VERSION,
          source_type: "calendar_reconciliation",
          event_id: event.event_id,
          risk_tier_reason: reviewTier.reason,
        },
      });

      if (reviewError) {
        throw new Error(`Could not create Calendar claim review item: ${reviewError.message}`);
      }
    }

    claimsCreated += 1;
  }

  let pendingCreated = 0;

  for (const pending of pendingItems) {
    const participant = participants.get(pending.entityName!.toLowerCase())!;
    await evidenceIdsFor(pending.supportingIndexes, participant.entityId);

    const summary = pending.summary!.trim();
    const detail = pending.detail?.trim() || null;
    const contextType = PENDING_TYPES.has(pending.contextType ?? "") ? pending.contextType! : "other";

    const { data: pendingRow, error: pendingError } = await supabaseServer
      .from("memory_pending_context")
      .insert({
        context_type: contextType,
        summary,
        detail,
        status: "pending",
        trigger_type: "manual",
        primary_entity_id: participant.entityId,
        source_id: sourceId,
        visibility: "normal",
        created_by: "ai",
        metadata: {
          generated_by: "calendar_reconciliation",
          ingestion_version: CALENDAR_PROCESSOR_VERSION,
          event_id: event.event_id,
        },
      })
      .select("id")
      .single();

    if (pendingError || !pendingRow) {
      throw new Error(`Could not create Calendar pending context: ${pendingError?.message ?? "Unknown error"}`);
    }

    const { error: reviewError } = await supabaseServer.from("memory_review_items").insert({
      review_type: "pending_context",
      status: "pending",
      title: summary,
      prompt: detail ?? `From meeting: ${event.subject ?? "Untitled"}`,
      entity_id: participant.entityId,
      pending_context_id: pendingRow.id,
      priority: 35,
      payload: {
        options: ["Follow up", "Keep waiting", "Resolved", "Dismiss"],
        generated_by: "calendar_reconciliation",
        ingestion_version: CALENDAR_PROCESSOR_VERSION,
        source_type: "calendar_reconciliation",
        event_id: event.event_id,
      },
    });

    if (reviewError) {
      throw new Error(`Could not create Calendar pending review item: ${reviewError.message}`);
    }

    pendingCreated += 1;
  }

  return { claimsCreated, pendingCreated };
}

export async function processPastCalendarEvent(event: CalendarEventRow, reconciliationTrigger: ReconciliationTrigger = "forward") {
  const fingerprint = calendarEventFingerprint(event);
  const { sourceId, metadata } = await findOrCreateCalendarEventSource(event);

  const fingerprintChanged = metadata.content_fingerprint !== fingerprint;
  const status = fingerprintChanged ? "pending" : metadata.retrospective_status ?? "pending";

  if (status === "complete") {
    return { processed: false as const, reason: "already_reconciled" as const };
  }

  const now = new Date();

  if (status === "initial_done") {
    const eligibleAt = metadata.retrospective_revisit_eligible_at
      ? new Date(metadata.retrospective_revisit_eligible_at)
      : null;

    if (eligibleAt && eligibleAt > now) {
      return { processed: false as const, reason: "revisit_not_yet_eligible" as const };
    }
  }

  const emails = attendeeEmails(event).filter((email) => email !== DAVE_EMAIL);
  const attendees = (await resolveAttendeeEntities(event)).filter((a) => a.email !== DAVE_EMAIL);

  const since = status === "initial_done" ? metadata.retrospective_initial_at ?? null : null;
  const relatedEvidence = await findRelatedEvidence(event, emails, since);

  const { claimsCreated, pendingCreated } = await reconcileFromEvidence(event, sourceId, attendees, relatedEvidence);

  const isRevisit = status === "initial_done";

  await updateCalendarEventSourceMetadata(sourceId, {
    ...metadata,
    event_id: event.event_id,
    calendar_processor_version: CALENDAR_PROCESSOR_VERSION,
    content_fingerprint: fingerprint,
    mode: "past",
    retrospective_status: isRevisit ? "complete" : "initial_done",
    retrospective_initial_at: metadata.retrospective_initial_at ?? now.toISOString(),
    retrospective_revisit_eligible_at: isRevisit
      ? metadata.retrospective_revisit_eligible_at
      : new Date(now.getTime() + REVISIT_DELAY_MS).toISOString(),
    retrospective_completed_at: isRevisit ? now.toISOString() : undefined,
    reconciliation_attempts: (metadata.reconciliation_attempts ?? 0) + 1,
  });

  /*
   * Action Reconciliation -- Calendar (Brief Part 1/9). Separate from the
   * Memory work above, wrapped so a failure here can never affect
   * Memory's already-completed, already-persisted work. Same nested
   * try/catch pattern proven in Phase 3 (email) and Phase 4 (Teams): an
   * inner failure marks the run failed (never stuck in_progress); an
   * outer failure (the run couldn't even start) is only logged.
   */
  try {
    const { runId, traceId } = await startReconciliationRun({
      trigger: reconciliationTrigger,
      sourceType: "calendar_event",
      sourceId: event.event_id,
      summary: `Reconcile past calendar event: ${event.subject ?? "Untitled"}`,
      metadata: { eventId: event.event_id, mode: "past" },
    });
    const counters = emptyCounters();
    try {
      const reconcileEvent: CalendarReconcileEvent = {
        eventId: event.event_id,
        subject: event.subject,
        description: event.body_html ? htmlToPlainText(event.body_html) : (event.body_preview ?? "").trim(),
        startTime: event.start_time,
        endTime: event.end_time,
        location: event.location ?? null,
        isRecurring: Boolean(event.is_recurring),
      };
      const reconciliationAttendees: ActorRef[] = attendees.map((a) => ({
        entityId: a.entityId,
        email: a.email,
        name: a.canonicalName,
      }));
      await reconcileCalendarEvent(reconcileEvent, reconciliationAttendees, runId, traceId, counters);
      await completeReconciliationRun(runId, traceId, {
        status: "completed",
        counters,
        summary: `Calendar event reconciled: ${counters.itemsCreated} created, ${counters.itemsMatched} matched, ${counters.itemsIgnored} ignored`,
      });
    } catch (innerError) {
      counters.errors += 1;
      await completeReconciliationRun(runId, traceId, {
        status: "failed",
        counters,
        summary: innerError instanceof Error ? innerError.message : "Unknown error",
      });
      throw innerError;
    }
  } catch (reconciliationError) {
    console.error("Action reconciliation failed for calendar event", event.event_id, reconciliationError);
  }

  return { processed: true as const, revisit: isRevisit, claimsCreated, pendingCreated };
}
