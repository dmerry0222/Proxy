import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { supabaseServer } from "@/lib/supabase/server";
import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { reconcileMemoryClaim } from "@/lib/memory/claimReconciliation";
import { startTrace, completeTrace, emitDiagnosticEvent, recordIssue } from "@/lib/diagnostics/emitEvent";
import { htmlToPlainText } from "@/lib/memory/htmlToPlainText";
import { extractEmailOperationalEvidence } from "@/lib/reconciliation/emailEvidence";
import { reconcileEnvelope } from "@/lib/reconciliation/reconcileEnvelope";
import { completeReconciliationRun, emptyCounters, recordReconciliationDecision, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { ReconciliationTrigger } from "@/lib/reconciliation/types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MEMORY_EMAIL_INGESTION_VERSION = 4;

type ClaimType =
  | "fact"
  | "role"
  | "responsibility"
  | "relationship"
  | "project_association"
  | "decision"
  | "status"
  | "milestone"
  | "preference"
  | "governing_context"
  | "working_context"
  | "other";

type PendingContextType =
  | "follow_up"
  | "waiting_on"
  | "deferred_idea"
  | "future_trigger"
  | "tweak"
  | "gift_idea"
  | "performance_note"
  | "reminder_context"
  | "other";

type EvidenceStrength =
  | "weak"
  | "moderate"
  | "strong";

type ExtractedClaim = {
  claimType: string;
  statement: string;
  evidenceStrength: string;
};

type ExtractedPendingContext = {
  contextType: string;
  summary: string;
  detail?: string | null;
};

type ExtractionResult = {
  claims?: ExtractedClaim[];
  pendingContext?: ExtractedPendingContext[];
};

const validClaimTypes =
  new Set<string>([
    "fact",
    "role",
    "responsibility",
    "relationship",
    "project_association",
    "decision",
    "status",
    "milestone",
    "preference",
    "governing_context",
    "working_context",
    "other",
  ]);

const validPendingTypes =
  new Set<string>([
    "follow_up",
    "waiting_on",
    "deferred_idea",
    "future_trigger",
    "tweak",
    "gift_idea",
    "performance_note",
    "reminder_context",
    "other",
  ]);

const validEvidenceStrengths =
  new Set<string>([
    "weak",
    "moderate",
    "strong",
  ]);

function redactSensitiveContent(
  text: string
) {
  return text
    .replace(
      /((?:password|passwd|passcode|pwd|pw)\s*[:=]\s*)([^\s<;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*)([^\s<;]+)/gi,
      "$1[REDACTED]"
    );
}


export function stripQuotedReplyHistory(
  text: string
) {
  const markers = [
    /^from:\s.+$/im,
    /^on .+ wrote:$/im,
    /^-{2,}\s*original message\s*-{2,}$/im,
    /^_{5,}$/m,
  ];

  let cutoff =
    text.length;

  for (
    const marker
    of markers
  ) {
    const match =
      marker.exec(text);

    if (
      match &&
      match.index <
        cutoff
    ) {
      cutoff =
        match.index;
    }
  }

  return text
    .slice(
      0,
      cutoff
    )
    .trim();
}

function isRoutineCalendarResponse(
  subject: string | null
) {
  const normalized =
    subject
      ?.trim()
      .toLowerCase() ??
    "";

  return (
    normalized.startsWith(
      "accepted:"
    ) ||
    normalized.startsWith(
      "declined:"
    ) ||
    normalized.startsWith(
      "tentative:"
    ) ||
    normalized.startsWith(
      "canceled:"
    ) ||
    normalized.startsWith(
      "cancelled:"
    )
  );
}

function hasExplicitOwnershipSignal(
  text: string
) {
  const normalized =
    text
      .replace(
        /\s+/g,
        " "
      )
      .toLowerCase();

  const ownershipPatterns = [
    /\bi\s+(?:currently\s+)?manage\b/,
    /\bi\s+(?:currently\s+)?oversee\b/,
    /\bi\s+(?:currently\s+)?lead\b/,
    /\bi\s+(?:currently\s+)?coordinate\b/,
    /\bi\s+(?:currently\s+)?administer\b/,
    /\bi\s+(?:currently\s+)?run\b/,
    /\bi\s+(?:currently\s+)?handle\b/,
    /\bi\s+own\b/,
    /\bi(?:'m| am)\s+responsible for\b/,
    /\bmy responsibility is\b/,
    /\bmy responsibilities include\b/,
    /\bpart of my role\b/,
    /\bmy role is\b/,
    /\bi(?:'m| am)\s+the\s+(?:lead|owner|point person)\b/,
  ];

  return ownershipPatterns.some(
    (pattern) =>
      pattern.test(
        normalized
      )
  );
}

/*
 * Claude occasionally returns perfectly valid JSON
 * inside a fenced block and then adds commentary after it.
 *
 * We first try the whole response, then a fenced block,
 * then scan for the first balanced JSON object.
 */
function parseExtractionJson(
  rawText: string
): ExtractionResult {
  const trimmed =
    rawText.trim();

  try {
    return JSON.parse(
      trimmed
    ) as ExtractionResult;
  } catch {
    // Continue.
  }

  const fencedMatch =
    trimmed.match(
      /```(?:json)?\s*([\s\S]*?)```/i
    );

  if (
    fencedMatch?.[1]
  ) {
    try {
      return JSON.parse(
        fencedMatch[1].trim()
      ) as ExtractionResult;
    } catch {
      // Continue to balanced-object scan.
    }
  }

  for (
    let start = 0;
    start <
    trimmed.length;
    start += 1
  ) {
    if (
      trimmed[start] !==
      "{"
    ) {
      continue;
    }

    let depth = 0;
    let inString =
      false;
    let escaped =
      false;

    for (
      let index =
        start;
      index <
      trimmed.length;
      index += 1
    ) {
      const char =
        trimmed[index];

      if (
        inString
      ) {
        if (escaped) {
          escaped =
            false;

          continue;
        }

        if (
          char === "\\"
        ) {
          escaped =
            true;

          continue;
        }

        if (
          char === '"'
        ) {
          inString =
            false;
        }

        continue;
      }

      if (
        char === '"'
      ) {
        inString =
          true;

        continue;
      }

      if (
        char === "{"
      ) {
        depth +=
          1;
      } else if (
        char === "}"
      ) {
        depth -=
          1;

        if (
          depth === 0
        ) {
          const candidate =
            trimmed.slice(
              start,
              index +
                1
            );

          try {
            return JSON.parse(
              candidate
            ) as ExtractionResult;
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(
    `Could not parse Memory extraction JSON: ${rawText}`
  );
}

/**
 * The Action Reconciliation half of email ingestion, extracted so a
 * historical backfill can force it directly for an email whose Memory
 * ingestion is already at the current version (and would otherwise skip
 * past this step entirely) without duplicating this logic in a second
 * pipeline. Behavior is unchanged from before the extraction -- same
 * calls, same error isolation (a failure here is logged, never thrown,
 * so it can never affect the caller's own success).
 */
export async function reconcileEmailEvidence(input: {
  outlookMessageId: string;
  establishedSourceId: string;
  subject: string | null;
  messageAt: string;
  senderName: string | null;
  senderEmail: string;
  senderEntityId: string;
  content: string;
  trigger: ReconciliationTrigger;
}): Promise<void> {
  try {
    const { runId, traceId: reconciliationTraceId } = await startReconciliationRun({
      trigger: input.trigger,
      sourceType: "email",
      sourceId: input.outlookMessageId,
      summary: `Reconcile email: ${input.subject ?? "Untitled"}`,
      metadata: { outlookMessageId: input.outlookMessageId, sourceId: input.establishedSourceId },
    });
    const counters = emptyCounters();

    try {
      const classified = await extractEmailOperationalEvidence({
        subject: input.subject,
        messageAt: input.messageAt,
        senderName: input.senderName,
        senderEmail: input.senderEmail,
        senderEntityId: input.senderEntityId,
        content: input.content,
      });
      counters.evidenceConsidered = classified.length;

      for (const { raw, envelope } of classified) {
        if (!envelope) {
          counters.itemsIgnored += 1;
          await recordReconciliationDecision(reconciliationTraceId, {
            runId,
            evidenceRef: { outlookMessageId: input.outlookMessageId, kind: raw.kind ?? "none" },
            outcome: "no_action",
            automatic: true,
            reasoningSummary:
              raw.kind && raw.kind !== "none"
                ? `Classified as "${raw.kind}" but missing a required field (excerpt, valid ownership basis, or resolvable external actor); no action taken.`
                : "No ownership, completion, or cancellation evidence cleared the bar for operational action.",
          });
          continue;
        }

        const fullEnvelope = {
          ...envelope,
          sourceType: "email" as const,
          sourceLocator: { outlook_message_id: input.outlookMessageId },
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
        summary: `Email reconciled: ${counters.itemsCreated} created, ${counters.itemsMatched} matched, ${counters.itemsIgnored} ignored`,
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
    console.error("Action reconciliation failed for email", input.outlookMessageId, reconciliationError);
  }
}

export async function ingestEmailToMemory(
  outlookMessageId: string,
  reconciliationTrigger: ReconciliationTrigger = "forward"
) {
  const traceId = await startTrace({
    module: "memory",
    sourceType: "email",
    sourceId: outlookMessageId,
    objectType: "email",
    objectId: outlookMessageId,
    summary: "Processing email",
  });

  try {
    return await ingestEmailToMemoryTraced(outlookMessageId, traceId, reconciliationTrigger);
  } catch (error) {
    await recordIssue({
      traceId,
      issueType: "email_ingestion_failure",
      severity: "error",
      humanSummary: "Proxy failed while processing this email for Memory.",
      humanDetail: error instanceof Error ? error.message : "Unknown error",
      objectType: "email",
      objectId: outlookMessageId,
      sourceType: "email",
      sourceId: outlookMessageId,
      retryable: true,
      technicalDetail: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    await completeTrace(traceId, { status: "failed", summary: "Email processing failed." });
    throw error;
  }
}

async function ingestEmailToMemoryTraced(
  outlookMessageId: string,
  traceId: string | null,
  reconciliationTrigger: ReconciliationTrigger = "forward"
) {
  /*
   * 1. Load canonical email.
   */
  const {
    data: email,
    error: emailError,
  } =
    await supabaseServer
      .from(
        "emails"
      )
      .select(`
        outlook_message_id,
        conversation_id,
        direction,
        folder,
        from_name,
        from_email,
        subject,
        body_preview,
        body_html,
        message_at
      `)
      .eq(
        "outlook_message_id",
        outlookMessageId
      )
      .single();

  if (
    emailError ||
    !email
  ) {
    throw new Error(
      `Could not load email: ${
        emailError
          ?.message ??
        "Email not found"
      }`
    );
  }

  const loadedEmail =
    email;

  await emitDiagnosticEvent({
    traceId,
    module: "memory",
    stage: "received",
    eventType: "email_loaded",
    status: "success",
    objectType: "email",
    objectId: outlookMessageId,
    humanSummary: `Received email: "${loadedEmail.subject ?? "Untitled"}"`,
    metadata: { from: loadedEmail.from_email },
  });

  /*
   * 2. Resolve sender.
   */
  const resolution =
    await resolveMemoryEntityByEmail(
      loadedEmail.from_email
    );

  if (!resolution) {
    await emitDiagnosticEvent({
      traceId,
      module: "memory",
      stage: "identified",
      eventType: "sender_resolution",
      status: "warning",
      humanSummary: "Proxy couldn't match the sender to a known person, so this email was skipped.",
      metadata: { from: loadedEmail.from_email },
    });
    await completeTrace(traceId, { status: "completed", summary: "Skipped — sender not recognized." });

    return {
      ingested:
        false,

      reason:
        "sender_not_resolved",
    };
  }

  await emitDiagnosticEvent({
    traceId,
    module: "memory",
    stage: "identified",
    eventType: "sender_resolution",
    status: "success",
    objectType: "memory_entity",
    objectId: resolution.entityId,
    humanSummary: `Recognized sender as ${resolution.canonicalName}.`,
  });

  /*
   * 3. Find or create Memory source.
   */
  const {
    data:
      existingSource,
    error:
      existingSourceError,
  } =
    await supabaseServer
      .from(
        "memory_sources"
      )
      .select(
        "id, metadata"
      )
      .eq(
        "canonical_table",
        "emails"
      )
      .eq(
        "canonical_record_id",
        outlookMessageId
      )
      .maybeSingle();

  if (
    existingSourceError
  ) {
    throw new Error(
      `Could not check existing Memory source: ${existingSourceError.message}`
    );
  }

  let sourceId =
    existingSource?.id;

  let sourceMetadata:
    Record<
      string,
      unknown
    > =
    (
      existingSource
        ?.metadata &&
      typeof existingSource
        .metadata ===
        "object"
    )
      ? existingSource
          .metadata as Record<
            string,
            unknown
          >
      : {};

  const existingVersion =
    Number(
      sourceMetadata
        .memory_ingestion_version ??
      0
    );

  /*
   * Versioned idempotency.
   */
  if (
    sourceId &&
    existingVersion >=
      MEMORY_EMAIL_INGESTION_VERSION
  ) {
    await completeTrace(traceId, { status: "completed", summary: "Already processed by Memory." });

    return {
      ingested:
        false,

      reason:
        "already_ingested",

      sourceId,

      entity:
        resolution.canonicalName,

      ingestionVersion:
        existingVersion,
    };
  }

  if (!sourceId) {
    sourceMetadata = {
      conversation_id:
        loadedEmail.conversation_id,

      direction:
        loadedEmail.direction,

      folder:
        loadedEmail.folder,
    };

    const {
      data:
        newSource,
      error:
        sourceError,
    } =
      await supabaseServer
        .from(
          "memory_sources"
        )
        .insert({
          source_type:
            "email",

          title:
            loadedEmail.subject ??
            "Email",

          canonical_table:
            "emails",

          canonical_record_id:
            outlookMessageId,

          /*
           * Full body remains canonical in public.emails.
           */
          content_text:
            loadedEmail.body_preview ??
            "",

          author_name:
            loadedEmail.from_name ||
            loadedEmail.from_email,

          source_at:
            loadedEmail.message_at,

          metadata:
            sourceMetadata,
        })
        .select(
          "id, metadata"
        )
        .single();

    if (
      sourceError ||
      !newSource
    ) {
      throw new Error(
        `Could not create Memory source: ${
          sourceError
            ?.message ??
          "Unknown error"
        }`
      );
    }

    sourceId =
      newSource.id;

    sourceMetadata =
      (
        newSource
          .metadata &&
        typeof newSource
          .metadata ===
          "object"
      )
        ? newSource
            .metadata as Record<
              string,
              unknown
            >
        : sourceMetadata;
  }

  if (!sourceId) {
    throw new Error(
      "Memory source ID was not established."
    );
  }

  const establishedSourceId =
    sourceId;

  await emitDiagnosticEvent({
    traceId,
    module: "memory",
    stage: "stored",
    eventType: "memory_source_ready",
    status: "success",
    objectType: "memory_source",
    objectId: establishedSourceId,
    humanSummary: existingSource
      ? "Found the existing Memory source record for this email."
      : "Stored this email as a Memory source.",
  });

  async function markSourceProcessed(
    extraMetadata:
      Record<
        string,
        unknown
      > = {}
  ) {
    const {
      error,
    } =
      await supabaseServer
        .from(
          "memory_sources"
        )
        .update({
          metadata: {
            ...sourceMetadata,

            conversation_id:
              loadedEmail.conversation_id,

            direction:
              loadedEmail.direction,

            folder:
              loadedEmail.folder,

            memory_ingestion_version:
              MEMORY_EMAIL_INGESTION_VERSION,

            memory_ingested_at:
              new Date()
                .toISOString(),

            ...extraMetadata,
          },
        })
        .eq(
          "id",
          establishedSourceId
        );

    if (error) {
      throw new Error(
        `Could not mark Memory source as ingested: ${error.message}`
      );
    }
  }

  /*
   * 4. Skip obvious calendar-response noise.
   */
  if (
    isRoutineCalendarResponse(
      loadedEmail.subject
    )
  ) {
    await markSourceProcessed({
      memory_ingestion_result:
        "skipped",

      memory_skip_reason:
        "routine_calendar_response",
    });

    await emitDiagnosticEvent({
      traceId,
      module: "memory",
      stage: "extracted",
      eventType: "extraction_skipped",
      status: "success",
      objectType: "memory_source",
      objectId: establishedSourceId,
      humanSummary: "Skipped extraction — this was a routine calendar response, not meaningful content.",
    });
    await completeTrace(traceId, { status: "completed", summary: "Skipped — routine calendar response." });

    return {
      ingested:
        true,

      entity:
        resolution.canonicalName,

      sourceId:
        establishedSourceId,

      ingestionVersion:
        MEMORY_EMAIL_INGESTION_VERSION,

      skipped:
        true,

      reason:
        "routine_calendar_response",

      claimsCreated:
        0,

      pendingCreated:
        0,
    };
  }

  /*
   * 5. Prepare current-message content.
   */
  const rawEmailContent =
    loadedEmail.body_html
      ? htmlToPlainText(
          loadedEmail.body_html
        )
      : (
          loadedEmail.body_preview ??
          ""
        ).trim();

  const currentMessageContent =
    stripQuotedReplyHistory(
      rawEmailContent
    );

  const emailContent =
    redactSensitiveContent(
      currentMessageContent
    );

  /*
   * 6. Claude extraction.
   */
  const message =
    await anthropic
      .messages
      .create({
        model:
          "claude-sonnet-4-5-20250929",

        max_tokens:
          1200,

        system: `
You extract only high-value persistent context for a personal AI Chief of Staff.

The Chief of Staff serves Dave Merry.

The Known Person is the only entity to whom claims may be attached in this extraction pass.

Do not summarize the email.

Return zero items unless something is genuinely worth remembering or resurfacing later.

STRICT VOLUME RULE:
- Maximum 2 claims.
- Maximum 1 pending-context item.
- Prefer fewer.
- If several observations describe the same underlying situation, consolidate them.

CLAIMS

Claims must primarily be about the Known Person.

Good examples:
- "Aki is coordinating the Groundwork rollout."
- "Aki is working with Dave on Handshake data visualization."
- "Aki prefers giving staff advance notice before major process changes."

Do NOT output claims whose primary subject is another person, organization, vendor, system, or event.

Examples you must NOT output in this pass:
- "Kayla is on parental leave."
- "Kelly is Suffolk's temporary Handshake RM."
- "Handshake is migrating its reporting API."
- "The Groundwork all-staff meeting is Wednesday."

Those facts may appear in the source, but this extraction pass is for the Known Person only.

A single instance of someone doing something does not automatically establish permanent ownership.

Example:
"Aki sent test accounts" does not necessarily mean
"Aki owns account provisioning."

Only use responsibility or role claims when the email clearly supports ongoing ownership or responsibility.

Be especially conservative about preferences and habitual working styles.

One isolated choice should usually remain evidence rather than become a generalized preference.

PENDING CONTEXT

Pending context is specifically for something Dave may reasonably need to act on, wait for, decide about, remember at a useful future moment, or benefit from having resurfaced.

A future fact by itself is NOT pending context.

Good:
- Dave is waiting for someone's response.
- Dave has a follow-up that may become overdue.
- Someone has made a commitment that affects Dave's work and still needs completion.
- A blocker is preventing something Dave is working on.
- Dave needs to review or decide something by a meaningful deadline.
- A deferred idea would be useful to resurface to Dave later.
- A future event creates a meaningful preparation, decision, or follow-up need for Dave.

Bad:
- Another person has a future meeting.
- Someone accepted an invitation.
- A date appears in the email.
- A meeting was merely rescheduled.
- Routine scheduling.
- A future event exists but Dave has no action, dependency, decision, or meaningful reason to be reminded.
- Information already adequately represented in Calendar.

Ask yourself:

"If Proxy surfaced this to Dave later, would it help him do something, remember something consequential, make a decision, or notice that something he is waiting for has not happened?"

If not, do not create pending context.

A pending item must be understandable on its own.

TEMPORAL GROUNDING

The supplied Email date is authoritative source time.

Use it to interpret all relative or incomplete dates.

Rules:
- "today" means the calendar date of the Email date.
- "tomorrow" is relative to the Email date.
- weekday references such as "Monday" or "Friday" must be interpreted relative to the Email date and surrounding context.
- if the email says a month/day without a year, infer the year from the Email date unless the surrounding text clearly requires crossing into the next or previous year.
- never silently substitute a different year.
- never invent a date that is not supported by the source.
- if a date is ambiguous, describe it without inventing precision.

Example:
If the Email date is 2026-08-21 and the message says "August 21" with no other year context, treat it as 2026-08-21, not 2025-08-21.

QUOTED OR PASTED MATERIAL

Emails may contain:
- reply history
- forwarded messages
- pasted prior emails
- quotations from other people

Treat those as supporting source material only.

Do not attribute quoted statements to the Known Person.

Do not create claims about third parties merely because their statements were pasted into the Known Person's email.

If the Known Person says:
"I pasted Kayla's prior update below and I'm following up on API access"

then a valid extraction might be:
"Aki is following up on Handshake API access for data-visualization work."

Do not separately extract every claim from Kayla's quoted update.

SECURITY RULE

Never extract, reproduce, store, summarize, or include:
- passwords
- passcodes
- API keys
- access tokens
- refresh tokens
- private keys
- authentication secrets
- recovery codes
- similar credentials

You may remember only the non-secret fact that access or credentials were provided if that fact itself matters.

CLAIM TYPES

You MUST use exactly one:
- fact
- role
- responsibility
- relationship
- project_association
- decision
- status
- milestone
- preference
- governing_context
- working_context
- other

PENDING CONTEXT TYPES

You MUST use exactly one:
- follow_up
- waiting_on
- deferred_idea
- future_trigger
- tweak
- gift_idea
- performance_note
- reminder_context
- other

Do not invent new types.

Be conservative.

Do not create claims from:
- greetings
- routine logistics
- scheduling
- FYIs with no durable significance
- one-time actions presented as permanent responsibility
- speculation
- quoted third-party facts

Do not assume something is decided merely because it is discussed.

Return JSON only.

Shape:
{
  "claims": [
    {
      "claimType": "...",
      "statement": "...",
      "evidenceStrength": "weak|moderate|strong"
    }
  ],
  "pendingContext": [
    {
      "contextType": "...",
      "summary": "...",
      "detail": "..."
    }
  ]
}
`,

        messages: [
          {
            role:
              "user",

            content: `
Known Person:
${resolution.canonicalName}

Chief of Staff user:
Dave Merry

Authoritative Email date:
${loadedEmail.message_at ?? ""}

Email subject:
${loadedEmail.subject ?? ""}

Current email content:
${emailContent}
`,
          },
        ],
      });

  /*
   * 7. Parse Claude JSON.
   */
  const textBlock =
    message.content.find(
      (block) =>
        block.type ===
        "text"
    );

  if (
    !textBlock ||
    textBlock.type !==
      "text"
  ) {
    throw new Error(
      "Claude returned no text"
    );
  }

  const extracted =
    parseExtractionJson(
      textBlock.text
    );

  /*
   * Hard caps and structural guards.
   *
   * An AI-generated role/responsibility claim cannot
   * survive unless the source email itself contains
   * explicit ownership language.
   */
  const claims =
    Array.isArray(
      extracted.claims
    )
      ? extracted.claims
          .filter(
            (claim) =>
              typeof claim
                ?.statement ===
                "string" &&
              claim.statement
                .trim()
          )
          .filter(
            (claim) => {
              const proposedType =
                claim.claimType;

              if (
                proposedType !==
                  "role" &&
                proposedType !==
                  "responsibility"
              ) {
                return true;
              }

              return hasExplicitOwnershipSignal(
                emailContent
              );
            }
          )
          .slice(
            0,
            2
          )
      : [];

  const pendingContext =
    Array.isArray(
      extracted.pendingContext
    )
      ? extracted
          .pendingContext
          .filter(
            (pending) =>
              typeof pending
                ?.summary ===
                "string" &&
              pending.summary
                .trim()
          )
          .slice(
            0,
            1
          )
      : [];

  await emitDiagnosticEvent({
    traceId,
    module: "memory",
    stage: "extracted",
    eventType: "extraction_complete",
    status: "success",
    objectType: "memory_source",
    objectId: establishedSourceId,
    humanSummary: `Extracted ${claims.length} observation${claims.length === 1 ? "" : "s"} and ${
      pendingContext.length
    } pending item${pendingContext.length === 1 ? "" : "s"} from this email.`,
    metadata: { claims_extracted: claims.length, pending_extracted: pendingContext.length },
  });

  /*
   * 8. Create candidate claims.
   */
  let claimsCreated = 0;
  for (
    const claim
    of claims
  ) {
    const claimType:
      ClaimType =
      validClaimTypes.has(
        claim.claimType
      )
        ? claim
            .claimType as ClaimType
        : "other";

    const evidenceStrength:
      EvidenceStrength =
      validEvidenceStrengths.has(
        claim.evidenceStrength
      )
        ? claim
            .evidenceStrength as EvidenceStrength
        : "weak";

    const statement =
      claim.statement
        .trim();

    const reconciliation = await reconcileMemoryClaim({
      entityId: resolution.entityId,
      sourceId: establishedSourceId,
      statement,
      claimType,
      evidenceContent: statement,
      evidenceStrength,
      effectiveFrom: loadedEmail.message_at,
      evidenceMetadata: { extraction_type: "claim_candidate", ingestion_version: MEMORY_EMAIL_INGESTION_VERSION },
      claimMetadata: { source_type: "email", source_id: establishedSourceId,
        ingestion_version: MEMORY_EMAIL_INGESTION_VERSION },
      reviewTitle: "Review extracted Memory",
      reviewPriority: 40,
      reviewPayload: { options: ["Confirm", "Outdated", "Keep as evidence", "Not sure", "Dismiss"],
        generated_by: "email_ingestion", ingestion_version: MEMORY_EMAIL_INGESTION_VERSION,
        source_subject: loadedEmail.subject, source_date: loadedEmail.message_at, source_type: "email" },
      traceId,
    });
    if (reconciliation.claimCreated) claimsCreated += 1;
  }

  /*
   * 9. Create at most one pending-context item.
   */
  for (
    const pending
    of pendingContext
  ) {
    const contextType:
      PendingContextType =
      validPendingTypes.has(
        pending.contextType
      )
        ? pending
            .contextType as PendingContextType
        : "other";

    const summary =
      pending.summary
        .trim();

    const detail =
      pending.detail
        ?.trim() ||
      null;

    const {
      data:
        pendingRow,
      error:
        pendingError,
    } =
      await supabaseServer
        .from(
          "memory_pending_context"
        )
        .insert({
          context_type:
            contextType,

          summary,

          detail,

          status:
            "pending",

          trigger_type:
            "manual",

          primary_entity_id:
            resolution.entityId,

          source_id:
            establishedSourceId,

          visibility:
            "normal",

          created_by:
            "ai",

          metadata: {
            generated_by:
              "email_ingestion",

            ingestion_version:
              MEMORY_EMAIL_INGESTION_VERSION,
          },
        })
        .select("id")
        .single();

    if (
      pendingError ||
      !pendingRow
    ) {
      throw new Error(
        `Could not create pending Memory context: ${
          pendingError
            ?.message ??
          "Unknown error"
        }`
      );
    }

    const {
      error:
        reviewError,
    } =
      await supabaseServer
        .from(
          "memory_review_items"
        )
        .insert({
          review_type:
            "pending_context",

          status:
            "pending",

          title:
            summary,

          prompt:
            detail ??
            `From email: ${
              loadedEmail.subject ??
              "Untitled email"
            }`,

          entity_id:
            resolution.entityId,

          pending_context_id:
            pendingRow.id,

          priority:
            35,

          payload: {
            options: [
              "Follow up",
              "Keep waiting",
              "Resolved",
              "Dismiss",
            ],

            generated_by:
              "email_ingestion",

            ingestion_version:
              MEMORY_EMAIL_INGESTION_VERSION,

            source_subject:
              loadedEmail.subject,

            source_date:
              loadedEmail.message_at,

            source_type:
              "email",
          },
        });

    if (
      reviewError
    ) {
      throw new Error(
        `Could not create pending Memory review item: ${reviewError.message}`
      );
    }
  }

  /*
   * 9.5. Action Reconciliation -- operational evidence.
   *
   * A separate, additional model call from the Memory extraction above,
   * so a failure or future change here can never affect Memory's
   * claims/pending-context behavior (Brief Part 8: "Keep Memory
   * extraction unchanged"). Wrapped so any error is recorded, not thrown
   * -- this step augments Execute state; it must never be the reason an
   * email fails to be marked processed for Memory.
   */
  await reconcileEmailEvidence({
    outlookMessageId,
    establishedSourceId,
    subject: loadedEmail.subject,
    messageAt: loadedEmail.message_at,
    senderName: loadedEmail.from_name,
    senderEmail: loadedEmail.from_email,
    senderEntityId: resolution.entityId,
    content: emailContent,
    trigger: reconciliationTrigger,
  });

  /*
   * 10. Mark source as successfully processed.
   *
   * Zero-output emails are still marked processed.
   */
  await markSourceProcessed({
    memory_ingestion_result:
      "processed",

    memory_claims_created:
      claimsCreated,

    memory_pending_created:
      pendingContext.length,
  });

  await emitDiagnosticEvent({
    traceId,
    module: "memory",
    stage: "acted",
    eventType: "email_ingestion_complete",
    status: "success",
    objectType: "memory_source",
    objectId: establishedSourceId,
    humanSummary: `Finished processing this email: ${claimsCreated} claim${
      claimsCreated === 1 ? "" : "s"
    } created, ${pendingContext.length} pending item${pendingContext.length === 1 ? "" : "s"} added.`,
  });
  await completeTrace(traceId, {
    status: "completed",
    summary: `Processed — ${claimsCreated} claim${claimsCreated === 1 ? "" : "s"}, ${
      pendingContext.length
    } pending item${pendingContext.length === 1 ? "" : "s"}.`,
  });

  return {
    ingested:
      true,

    entity:
      resolution.canonicalName,

    sourceId:
      establishedSourceId,

    ingestionVersion:
      MEMORY_EMAIL_INGESTION_VERSION,

    claimsCreated:
      claimsCreated,

    pendingCreated:
      pendingContext.length,
  };
}
