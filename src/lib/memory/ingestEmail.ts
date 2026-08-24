import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { supabaseServer } from "@/lib/supabase/server";
import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";

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

function htmlToPlainText(
  html: string
) {
  return html
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<\/p>/gi,
      "\n"
    )
    .replace(
      /<\/div>/gi,
      "\n"
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      /\n\s*\n\s*\n+/g,
      "\n\n"
    )
    .trim();
}

function stripQuotedReplyHistory(
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

export async function ingestEmailToMemory(
  outlookMessageId: string
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

  /*
   * 2. Resolve sender.
   */
  const resolution =
    await resolveMemoryEntityByEmail(
      loadedEmail.from_email
    );

  if (!resolution) {
    return {
      ingested:
        false,

      reason:
        "sender_not_resolved",
    };
  }

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

  /*
   * 8. Create candidate claims.
   */
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

    const {
      data:
        evidence,
      error:
        evidenceError,
    } =
      await supabaseServer
        .from(
          "memory_evidence"
        )
        .insert({
          source_id:
            establishedSourceId,

          evidence_type:
            "excerpt",

          content:
            statement,

          effective_from:
            loadedEmail.message_at,

          visibility:
            "normal",

          extracted_by:
            "ai",

          metadata: {
            extraction_type:
              "claim_candidate",

            ingestion_version:
              MEMORY_EMAIL_INGESTION_VERSION,
          },
        })
        .select("id")
        .single();

    if (
      evidenceError ||
      !evidence
    ) {
      throw new Error(
        `Could not create Memory evidence: ${
          evidenceError
            ?.message ??
          "Unknown error"
        }`
      );
    }

    const {
      error:
        evidenceEntityError,
    } =
      await supabaseServer
        .from(
          "memory_evidence_entities"
        )
        .insert({
          evidence_id:
            evidence.id,

          entity_id:
            resolution.entityId,

          relationship:
            "subject",
        });

    if (
      evidenceEntityError
    ) {
      throw new Error(
        `Could not connect Memory evidence to entity: ${evidenceEntityError.message}`
      );
    }

    const {
      data:
        newClaim,
      error:
        claimError,
    } =
      await supabaseServer
        .from(
          "memory_claims"
        )
        .insert({
          claim_type:
            claimType,

          statement,

          status:
            "candidate",

          learned_at:
            new Date()
              .toISOString(),

          evidence_strength:
            evidenceStrength,

          promotion_basis:
            "ai_extraction",

          confirmed_by_user:
            false,

          visibility:
            "normal",

          created_by:
            "ai",

          metadata: {
            source_type:
              "email",

            source_id:
              establishedSourceId,

            ingestion_version:
              MEMORY_EMAIL_INGESTION_VERSION,
          },
        })
        .select("id")
        .single();

    if (
      claimError ||
      !newClaim
    ) {
      throw new Error(
        `Could not create candidate claim: ${
          claimError
            ?.message ??
          "Unknown error"
        }`
      );
    }

    const {
      error:
        claimEntityError,
    } =
      await supabaseServer
        .from(
          "memory_claim_entities"
        )
        .insert({
          claim_id:
            newClaim.id,

          entity_id:
            resolution.entityId,

          role:
            "subject",
        });

    if (
      claimEntityError
    ) {
      throw new Error(
        `Could not connect Memory claim to entity: ${claimEntityError.message}`
      );
    }

    const {
      error:
        claimEvidenceError,
    } =
      await supabaseServer
        .from(
          "memory_claim_evidence"
        )
        .insert({
          claim_id:
            newClaim.id,

          evidence_id:
            evidence.id,

          relationship:
            "supports",
        });

    if (
      claimEvidenceError
    ) {
      throw new Error(
        `Could not connect Memory claim to evidence: ${claimEvidenceError.message}`
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
            "confirm_claim",

          status:
            "pending",

          title:
            "Review extracted Memory",

          prompt:
            statement,

          claim_id:
            newClaim.id,

          entity_id:
            resolution.entityId,

          priority:
            40,

          payload: {
            options: [
              "Confirm",
              "Outdated",
              "Keep as evidence",
              "Not sure",
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
        `Could not create Memory claim review item: ${reviewError.message}`
      );
    }
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
   * 10. Mark source as successfully processed.
   *
   * Zero-output emails are still marked processed.
   */
  await markSourceProcessed({
    memory_ingestion_result:
      "processed",

    memory_claims_created:
      claims.length,

    memory_pending_created:
      pendingContext.length,
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
      claims.length,

    pendingCreated:
      pendingContext.length,
  };
}