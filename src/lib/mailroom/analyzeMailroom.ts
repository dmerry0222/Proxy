import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  isSystemNoise,
  loadMailroomConversationByConversationId,
  loadMailroomConversations,
  normalizeSubject,
} from "@/lib/mailroom/loadMailroom";

import {
  getMemoryEntityContext,
} from "@/lib/memory/getEntityContext";

import {
  resolveMemoryEntityByEmail,
} from "@/lib/memory/resolveEntity";

import { supabaseServer } from "@/lib/supabase/server";
import { buildCleanedEmailBody } from "@/lib/email/normalizeEmailBody";

import type {
  MailConversation,
  MailroomBucket,
} from "@/lib/mailroom/types";
import { defaultRequestedAction, type MailroomCategory } from "@/lib/mailroom/actionModel";
import { isActionableMeetingInvitation } from "@/lib/mailroom/normalizeOutlookMetadata";

const MAILBOX_OWNER_EMAIL = "dmerry@suffolk.edu";

/**
 * A conversation is a positively-identified, actionable live invitation
 * only via the shared deterministic structural predicate -- never from
 * AI/text heuristics, and never for forwarded meeting mail, responses,
 * or cancellations. See isActionableMeetingInvitation for the full gate.
 */
function detectMeetingInvitation(conversation: MailConversation): boolean {
  const latest =
    conversation.messages.find((message) => message.outlookMessageId === conversation.latestMessageId) ??
    conversation.messages[conversation.messages.length - 1];
  if (!latest) return false;
  return isActionableMeetingInvitation(
    {
      calendarMessageKind: latest.calendarMessageKind as "meeting_response" | "meeting_message" | "cancellation" | null,
      calendarAction: latest.calendarAction as "accepted" | "declined" | "tentative" | "cancelled" | null,
      calendarSeriesInstanceId: latest.calendarSeriesInstanceId,
      isMeetingForward: latest.isMeetingForward,
      direction: latest.direction,
      subject: latest.subject,
      toRecipients: latest.toRecipients,
      ccRecipients: latest.ccRecipients,
      isInInbox: latest.isInInbox,
    },
    MAILBOX_OWNER_EMAIL
  );
}

const BUCKET_TO_CATEGORY: Record<MailroomBucket, MailroomCategory> = {
  "Needs You": "needs_you",
  FYI: "fyi",
  "Professional News": "professional_news",
  "Low Value": "low_value",
  Calendar: "calendar",
  Workday: "workday",
};

const anthropic =
  new Anthropic({
    apiKey:
      process.env.ANTHROPIC_API_KEY,
  });

export type MailroomAnalysis = {
  category:
    MailroomBucket;

  summary:
    string;

  requiresAttention:
    boolean;

  confidence:
    number;

  suggestedReply:
    string | null;

  reasoningNote:
    string;

  isMeetingInvitation:
    boolean;
};

type OrgChartPerson = {
  employeeemail:
    string | null;

  employee_upn:
    string | null;

  employeename:
    string | null;

  employeejobtitle:
    string | null;

  employeedepartment:
    string | null;
};

function normalizeEmail(
  value:
    string | null | undefined
) {
  return value
    ?.trim()
    .toLowerCase() ??
    null;
}

async function loadOrgChartPeople(
  conversations:
    MailConversation[]
) {
  const emails =
    Array.from(
      new Set(
        conversations
          .flatMap(
            (
              conversation
            ) => [
              conversation.senderEmail,
              ...conversation.messages.map(
                (message) =>
                  message.fromEmail
              ),
            ]
          )
          .map(
            normalizeEmail
          )
          .filter(
  (
    email
  ): email is string => {
    if (!email) {
      return false;
    }

    return (
      email.endsWith(
        "@suffolk.edu"
      ) ||
      email.endsWith(
        "@adm.suffolk.edu"
      )
    );
  }
)
      )
    );

  const peopleByEmail =
    new Map<
      string,
      OrgChartPerson
    >();

  if (
    emails.length ===
    0
  ) {
    return peopleByEmail;
  }

  const orFilter =
    emails
      .flatMap(
        (
          email
        ) => [
          `employeeemail.ilike.${email}`,
          `employee_upn.ilike.${email}`,
        ]
      )
      .join(",");

  const {
    data,
    error,
  } =
    await supabaseServer
      .from(
        "org_chart"
      )
      .select(
        `
        employeeemail,
        employee_upn,
        employeename,
        employeejobtitle,
        employeedepartment
        `
      )
      .or(
        orFilter
      );

  if (error) {
    throw new Error(
      `Could not load org-chart identities for Mailroom: ${error.message}`
    );
  }

  for (
    const person
    of (
      data ??
      []
    ) as OrgChartPerson[]
  ) {
    const employeeEmail =
      normalizeEmail(
        person.employeeemail
      );

    const employeeUpn =
      normalizeEmail(
        person.employee_upn
      );

    if (
      employeeEmail
    ) {
      peopleByEmail.set(
        employeeEmail,
        person
      );
    }

    if (
      employeeUpn
    ) {
      peopleByEmail.set(
        employeeUpn,
        person
      );
    }
  }

  return peopleByEmail;
}

function formatKnownSender(
  email:
    string | null | undefined,
  fallbackName:
    string | null | undefined,
  peopleByEmail:
    Map<
      string,
      OrgChartPerson
    >
) {
  const normalizedEmail =
    normalizeEmail(
      email
    );

  const person =
    normalizedEmail
      ? peopleByEmail.get(
          normalizedEmail
        )
      : null;

  if (
    person?.employeename
  ) {
    return normalizedEmail
      ? `${person.employeename} <${normalizedEmail}>`
      : person.employeename;
  }

  if (
    fallbackName &&
    normalizedEmail
  ) {
    return `${fallbackName} <${normalizedEmail}>`;
  }

  return (
    fallbackName ||
    normalizedEmail ||
    "Unknown sender"
  );
}

function buildConversationText(
  conversation: MailConversation,
  peopleByEmail:
    Map<
      string,
      OrgChartPerson
    >
) {
  return conversation.messages
    .map(
      (
        message,
        index
      ) => {
        const sender =
          message.direction.toLowerCase() ===
          "outgoing"
            ? "Dave"
            : formatKnownSender(
                message.fromEmail,
                message.fromName,
                peopleByEmail
              );

        const noiseLabel =
          isSystemNoise(
            message
          )
            ? "System noise: yes"
            : "System noise: no";

        const normalizedMetadata = [
          `Calendar related: ${message.isCalendarRelated ? "yes" : "no"}`,
          `Calendar kind: ${message.calendarMessageKind ?? "none"}`,
          `Calendar action: ${message.calendarAction ?? "none"}`,
          `Automatic reply: ${message.isAutoReply ? "yes" : "no"}`,
          `Mailing list: ${message.isMailingList ? "yes" : "no"}`,
          `List ID: ${message.listId ?? "none"}`,
          `System generated: ${message.isSystemGenerated ? "yes" : "no"}`,
        ];

        const normalizedSubject =
          normalizeSubject(
            message.subject
          );

        const cleanedBody = buildCleanedEmailBody({
          bodyHtml: message.bodyHtml,
          bodyPreview: message.bodyPreview,
        }).text;

        return [
          `MESSAGE ${index + 1}`,
          `Direction: ${message.direction}`,
          `From: ${sender}`,
          `Date: ${message.messageAt ?? "Unknown"}`,
          `Normalized subject: ${normalizedSubject}`,
          `Original subject: ${message.subject ?? "(No subject)"}`,
          noiseLabel,
          ...normalizedMetadata,
          "",
          cleanedBody || "(No message text available)",
        ].join("\n");
      }
    )
    .join(
      "\n\n---\n\n"
    );
}

function defaultActionsForCategory(
  category: MailroomBucket,
  isMeetingInvitation: boolean
) {
  return defaultRequestedAction(BUCKET_TO_CATEGORY[category], isMeetingInvitation);
}

export async function analyzeMailroomConversation(
  conversation: MailConversation,
  peopleByEmail:
    Map<
      string,
      OrgChartPerson
    > =
      new Map()
): Promise<MailroomAnalysis> {
  if (conversation.systemType === "workday") {
    return {
      category: "Workday",
      summary: conversation.summary || `Workday notification: ${conversation.subject}`,
      requiresAttention: false,
      confidence: 0.99,
      suggestedReply: null,
      reasoningNote: "Deterministic Workday routing (sender domain), kept separate from Calendar.",
      isMeetingInvitation: false,
    };
  }

  if (conversation.isCalendarRelated) {
    const isMeetingInvitation = detectMeetingInvitation(conversation);
    return {
      category: "Calendar",
      summary: conversation.summary || `Calendar activity: ${conversation.subject}`,
      requiresAttention: false,
      confidence: 0.99,
      suggestedReply: null,
      reasoningNote: isMeetingInvitation
        ? "Deterministic Calendar routing: positively identified meeting invitation (structured Graph fields)."
        : "Deterministic Calendar routing from normalized Outlook metadata.",
      isMeetingInvitation,
    };
  }

  if (conversation.isAutoReply) {
    return {
      category: "Low Value",
      summary: conversation.summary || `Automatic reply: ${conversation.subject}`,
      requiresAttention: false,
      confidence: 0.98,
      suggestedReply: null,
      reasoningNote: "Deterministic automatic-reply default from normalized Outlook metadata.",
      isMeetingInvitation: false,
    };
  }

  if (
    !process.env
      .ANTHROPIC_API_KEY
  ) {
    throw new Error(
      "Missing ANTHROPIC_API_KEY"
    );
  }

  const conversationText =
    buildConversationText(
      conversation,
      peopleByEmail
    );

  const senderEmail =
    normalizeEmail(
      conversation.senderEmail
    );

  const orgChartPerson =
    senderEmail
      ? peopleByEmail.get(
          senderEmail
        )
      : null;

  const currentSender =
    formatKnownSender(
      conversation.senderEmail,
      conversation.senderName,
      peopleByEmail
    );

  const orgChartText =
    orgChartPerson
      ? [
          `Canonical Suffolk identity: ${orgChartPerson.employeename ?? currentSender}`,
          orgChartPerson.employeejobtitle
            ? `Job title: ${orgChartPerson.employeejobtitle}`
            : null,
          orgChartPerson.employeedepartment
            ? `Department: ${orgChartPerson.employeedepartment}`
            : null,
        ]
          .filter(
            (
              line
            ): line is string =>
              line !== null
          )
          .join("\n")
      : "No matching Suffolk org-chart identity was found for the current sender.";

  /*
   * MEMORY
   *
   * Try to resolve the current sender to a
   * canonical Memory entity.
   *
   * Unknown senders are completely valid:
   * Mailroom simply continues without
   * Memory enrichment.
   */
  const memoryResolution =
    await resolveMemoryEntityByEmail(
      conversation.senderEmail
    );

  const memoryContext =
    memoryResolution
      ? await getMemoryEntityContext(
          memoryResolution.entityId
        )
      : null;

  /*
   * Only established current claims and
   * relevant pending context should enter
   * Mailroom reasoning.
   *
   * Candidate claims and Memory Review
   * items deliberately stay out.
   */
  const memoryText =
    memoryContext
      ? [
          `Known person: ${memoryContext.entity.name}`,

          memoryResolution
            ? `Identity match: ${memoryResolution.matchType}`
            : null,

          "",

          "CURRENT MEMORY:",

          ...(memoryContext.currentClaims.length >
          0
            ? memoryContext.currentClaims.map(
                (claim) =>
                  `- ${claim.statement}`
              )
            : [
                "- No established current claims.",
              ]),

          "",

          "RELEVANT PENDING CONTEXT:",

          ...(memoryContext.pendingContext.length >
          0
            ? memoryContext.pendingContext.map(
                (item) =>
                  `- ${item.summary}`
              )
            : [
                "- None.",
              ]),
        ]
          .filter(
            (
              line
            ): line is string =>
              line !== null
          )
          .join("\n")
      : "No established Memory context for this sender.";

  const response =
    await anthropic.messages.create({
      model:
        "claude-sonnet-4-5",

      max_tokens:
        1200,

      system: `
You are Mailroom, an executive inbox triage assistant for Dave.

Your job is to classify an email conversation according to the kind of
attention it deserves.

CATEGORIES:

Needs You
Dave likely needs to respond, decide, approve, investigate, follow up,
or otherwise take meaningful action.

FYI
Useful information Dave should know, but no clear response or action
is currently required.

Professional News
Newsletters, professional reading, industry information, events,
research, product updates, or other potentially useful professional
content that does not require direct action.

Low Value
Advertising, generic promotions, low-value newsletters, irrelevant
notifications, spam-like mail, or information Dave is unlikely to need.

SUMMARY RULES:

- The summary must be ABSTRACTIVE, not a truncation or paraphrase of the
  opening lines. Read the whole message and answer: What is this actually
  about? Is the sender asking for something? Is there an update, decision,
  deadline, or informational point Dave needs?
- Never let institutional boilerplate (security banners, "this email
  originated from outside the organization" warnings, confidentiality
  notices) become the summary. If a message is ONLY boilerplate with no
  substantive content, say so plainly (e.g. "No substantive content --
  automated security notice only") rather than quoting the notice.
- Never let a greeting or pleasantry ("Hi Dave, hope you had a great
  weekend") stand in for the actual point of the email -- identify what
  the sender wants or is telling Dave, even if it appears several
  sentences in.
- GOOD: "Jordan is asking whether Suffolk can participate in the employer
  panel on October 4."
- GOOD: "Sarah shared the revised internship approval workflow and wants
  feedback before Friday."
- BAD: "CAUTION: This email originated from outside of the University..."
- BAD: "Hi Dave, hope you had a great weekend..."
- For a very short, already-substantive message (e.g. a one-line yes/no
  answer), a near-verbatim summary is fine -- the rule above is about
  never substituting boilerplate/greetings for substance, not about
  padding short messages artificially.

RULES:

- Analyze the whole thread, not just the latest message.
- Pay attention to whether Dave has already replied.
- Do not assume that being CC'd means action is required.
- Do not change read/unread status.
- Suggested replies should only be created when a reply is genuinely useful.
- Suggested replies should sound concise, warm, professional, and natural.
- Do not invent facts that are not in the email thread.
- reasoningNote is for debugging/calibration only and should be brief.
- Distinguish substantive human messages from system noise.
- Automatic replies, out-of-office notices, delivery notices, calendar response notifications,
  and similar system-generated messages should usually NOT determine the category of an otherwise
  substantive conversation.
- If the latest chronological message is system noise, base the classification primarily on the
  latest substantive incoming message and the overall thread.
- Mention system noise only when it materially changes what Dave needs to know.

IDENTITY RULES:

- When ORG CHART CONTEXT provides a canonical Suffolk identity, use that person's
  actual name. It is authoritative for naming the sender.
- Never infer or invent a person's name from the local part of an email address.
  For example, do not turn "aperham@suffolk.edu" into "Aperham" or guess a first
  name from "ehenderson@suffolk.edu".
- If no reliable human name is supplied by the org chart, Memory, or the message
  metadata, refer to the person by email address rather than guessing.
- Do not silently substitute a plausible name when identity is uncertain.

MEMORY RULES:

- Proxy Memory may provide established background context about the sender,
  shared projects, responsibilities, or unresolved relevant context.
- Use Memory only when it materially helps interpret the conversation.
- Do not force Memory context into the analysis when it is irrelevant.
- The email thread remains the primary evidence for what this particular
  conversation says, requests, or requires.
- Do not treat Memory as evidence that the sender said something in this thread.
- If the thread clearly contradicts older Memory context, follow the thread for
  this analysis rather than forcing the older Memory interpretation.
- Do not mention Memory, provenance, confidence metadata, or internal Memory
  mechanics in the user-facing summary or suggested reply.

Proxy itself determines the inbox action from the category.
Do NOT independently decide whether to flag or archive.

Return ONLY valid JSON with exactly this shape:

{
  "category": "Needs You" | "FYI" | "Professional News" | "Low Value",
  "summary": "1-3 sentence useful summary",
  "requiresAttention": true,
  "confidence": 0.92,
  "suggestedReply": "reply text or null",
  "reasoningNote": "brief explanation"
}
`.trim(),

      messages: [
        {
          role:
            "user",

          content: `
Analyze this Outlook conversation.

Conversation ID:
${conversation.conversationId}

Current subject:
${conversation.subject}

Current sender:
${currentSender}

NORMALIZED OUTLOOK METADATA:
Calendar related: ${conversation.isCalendarRelated ? "yes" : "no"}
Automatic reply: ${conversation.isAutoReply ? "yes" : "no"}
Mailing list: ${conversation.isMailingList ? "yes" : "no"}
List ID: ${conversation.listId ?? "none"}

Mailing-list status is a strong broadcast signal. Use it to distinguish direct correspondence from Professional News or Low Value, but still judge the actual content.

Latest substantive message ID:
${conversation.latestSubstantiveMessageId ?? "None identified"}

ORG CHART CONTEXT:

${orgChartText}

PROXY MEMORY CONTEXT:

${memoryText}

THREAD:

${conversationText}
`.trim(),
        },
      ],
    });

  const textBlock =
    response.content.find(
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
      "Claude returned no usable text response"
    );
  }

  const cleanedText =
    textBlock.text
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  let parsed:
    unknown;

  try {
    parsed =
      JSON.parse(
        cleanedText
      );
  } catch {
    throw new Error(
      `Claude returned invalid JSON:\n${textBlock.text}`
    );
  }

  const analysis =
    parsed as Partial<MailroomAnalysis>;

  const validCategories:
    MailroomBucket[] =
      [
        "Needs You",
        "FYI",
        "Professional News",
        "Low Value",
      ];

  if (
    !analysis.category ||
    !validCategories.includes(
      analysis.category
    )
  ) {
    throw new Error(
      "Claude returned an invalid Mailroom category"
    );
  }

  if (
    typeof analysis.summary !== "string" ||
    !analysis.summary.trim()
  ) {
    /*
     * Last-resort emergency fallback only -- not the normal path. A
     * malformed/missing summary here previously threw and failed the
     * ENTIRE batch's insert for this conversation (runMailroomAnalysis
     * aborts the whole run on any single conversation's error). Falling
     * back to a truncated CLEANED excerpt (never the raw banner-laden
     * bodyPreview) keeps one bad model response from taking down a whole
     * Mailroom run, while still never surfacing boilerplate as if it were
     * a real summary.
     */
    console.warn(`Mailroom: Claude returned no usable summary for "${conversation.subject}"; using a fallback excerpt.`);
    const fallbackMessage = conversation.messages[conversation.messages.length - 1] ?? null;
    const cleanedFallback = fallbackMessage
      ? buildCleanedEmailBody({ bodyHtml: fallbackMessage.bodyHtml, bodyPreview: fallbackMessage.bodyPreview }).text
      : "";
    analysis.summary = cleanedFallback
      ? cleanedFallback.slice(0, 200) + (cleanedFallback.length > 200 ? "…" : "")
      : conversation.summary || `Email from ${conversation.senderEmail ?? "unknown sender"} — no readable content.`;
  }

  return {
    category:
      analysis.category,

    summary:
      analysis.summary,

    requiresAttention:
      analysis.requiresAttention ===
      true,

    confidence:
      typeof analysis.confidence ===
      "number"
        ? Math.max(
            0,
            Math.min(
              1,
              analysis.confidence
            )
          )
        : 0,

    suggestedReply:
      typeof analysis.suggestedReply ===
      "string"
        ? analysis.suggestedReply
        : null,

    reasoningNote:
      typeof analysis.reasoningNote ===
      "string"
        ? analysis.reasoningNote
        : "",

    isMeetingInvitation: false,
  };
}

export async function runMailroomAnalysis() {
  const conversations =
    await loadMailroomConversations({
      includeProcessed:
        false,
      limit:
        50,
    });

  /*
   * Nothing new needs AI analysis.
   * Do not create an empty Mailroom run.
   */
  if (
    conversations.length ===
    0
  ) {
    return {
      runId:
        null,
      conversationsAnalyzed:
        0,
    };
  }

  /*
   * Resolve Suffolk sender identities once for the whole
   * batch so Claude receives canonical names instead of
   * guessing from email usernames.
   */
  const peopleByEmail =
    await loadOrgChartPeople(
      conversations
    );

  const {
    data:
      run,
    error:
      runError,
  } =
    await supabaseServer
      .from(
        "mailroom_runs"
      )
      .insert({
        status:
          "processing",

        model_provider:
          "anthropic",

        model_name:
          "claude-sonnet-4-5",

        messages_considered:
          conversations.reduce(
            (
              total,
              conversation
            ) =>
              total +
              conversation
                .messages
                .length,
            0
          ),

        conversations_considered:
          conversations.length,
      })
      .select("id")
      .single();

  if (
    runError ||
    !run
  ) {
    throw new Error(
      `Could not create Mailroom run: ${
        runError?.message ??
        "Unknown error"
      }`
    );
  }

  const runId =
    run.id;

  try {
    for (
      const conversation
      of conversations
    ) {
      const analysis =
        await analyzeMailroomConversation(
          conversation,
          peopleByEmail
        );

      const categoryForDatabase =
        analysis.category
          .toLowerCase()
          .replaceAll(
            " ",
            "_"
          );

      const {
        data:
          mailroomConversation,
        error:
          conversationError,
      } =
        await supabaseServer
          .from(
            "mailroom_conversations"
          )
          .insert({
            run_id:
              runId,

            conversation_id:
              conversation.conversationId,

            latest_message_id:
              conversation.latestMessageId,

            item_type:
              "conversation",

            category:
              categoryForDatabase,

            summary:
              analysis.summary,

            requires_attention:
              analysis.requiresAttention,

            confidence:
              analysis.confidence,

            suggested_reply:
              analysis.suggestedReply,

            received_at:
              conversation.latestMessageAt,

            is_meeting_invitation:
              analysis.isMeetingInvitation,

            requested_action:
              defaultActionsForCategory(analysis.category, analysis.isMeetingInvitation),

            /*
             * The recommendation is recorded alongside the initial
             * selection so a later human override stays measurable
             * against what Proxy originally proposed.
             */
            recommended_action:
              defaultActionsForCategory(analysis.category, analysis.isMeetingInvitation),

            selected_action_source: "default",
          })
          .select("id")
          .single();

      if (
        conversationError ||
        !mailroomConversation
      ) {
        throw new Error(
          `Could not save analysis for "${conversation.subject}": ${
            conversationError?.message ??
            "Unknown error"
          }`
        );
      }

      /*
       * Close the loop: this conversation's live Inbox messages must be
       * marked processed now that they have a current analysis, or this
       * exact selection query (includeProcessed: false) will pick the SAME
       * conversation again on the very next call. Discovered the hard way
       * -- an automated maintenance/backfill loop calling this function
       * repeatedly re-analyzed and re-inserted the same 38 conversations
       * 10 times in ~20 minutes before this fix, since nothing else in
       * this function ever touched `processed`. A genuinely new Inbox
       * message later flips this back to false via
       * staleAnalysisRepair.ts's reopenStaleMailroomConversations, so this
       * does not create a one-way "never analyzed again" trap.
       */
      const { error: markProcessedError } = await supabaseServer
        .from("emails")
        .update({ processed: true })
        .in("outlook_message_id", conversation.inboxMessageIds);

      if (markProcessedError) {
        throw new Error(
          `Analyzed "${conversation.subject}" but could not mark its Inbox messages processed: ${markProcessedError.message}`
        );
      }
    }

    const {
      error:
        completeError,
    } =
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .update({
          status:
            "ready_for_review",

          completed_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          runId
        );

    if (
      completeError
    ) {
      throw new Error(
        `Could not complete Mailroom run: ${completeError.message}`
      );
    }

    return {
      runId,

      conversationsAnalyzed:
        conversations.length,
    };
  } catch (
    error
  ) {
    await supabaseServer
      .from(
        "mailroom_runs"
      )
      .update({
        status:
          "failed",

        completed_at:
          new Date()
            .toISOString(),

        error_message:
          error instanceof
          Error
            ? error.message
            : "Unknown analysis error",
      })
      .eq(
        "id",
        runId
      );

    throw error;
  }
}

export type ReconstructedMailroomAnalysis = {
  mailroomConversationId: string;
  conversation: {
    id: string;
    conversation_id: string;
    category: string;
    requested_action: string | null;
    recommended_action: string | null;
    suggested_reply: string | null;
    is_meeting_invitation: boolean;
    review_state: string | null;
  };
};

/**
 * Rebuilds a missing mailroom_conversations analysis row for one
 * conversation that still has underlying email records -- e.g. the row was
 * purged, or the conversation was never analyzed before this batch window
 * moved past it. Reuses the same single-conversation analyzer and default
 * action model as the batch run (runMailroomAnalysis), scoped to one
 * conversation and its own single-conversation mailroom_runs record rather
 * than a batch of 50.
 *
 * Returns null when there is nothing left to analyze (no email rows for
 * this conversation) -- distinct from throwing, which means the email
 * exists but analysis itself failed.
 */
export async function reconstructMailroomAnalysis(
  conversationId: string
): Promise<ReconstructedMailroomAnalysis | null> {
  const conversation = await loadMailroomConversationByConversationId(conversationId);
  if (!conversation) {
    return null;
  }

  const peopleByEmail = await loadOrgChartPeople([conversation]);
  const analysis = await analyzeMailroomConversation(conversation, peopleByEmail);

  const { data: run, error: runError } = await supabaseServer
    .from("mailroom_runs")
    .insert({
      status: "processing",
      model_provider: "anthropic",
      model_name: "claude-sonnet-4-5",
      messages_considered: conversation.messages.length,
      conversations_considered: 1,
    })
    .select("id")
    .single();

  if (runError || !run) {
    throw new Error(`Could not create Mailroom reconstruction run: ${runError?.message ?? "Unknown error"}`);
  }

  const categoryForDatabase = analysis.category.toLowerCase().replaceAll(" ", "_");

  const { data: mailroomConversation, error: conversationError } = await supabaseServer
    .from("mailroom_conversations")
    .insert({
      run_id: run.id,
      conversation_id: conversation.conversationId,
      latest_message_id: conversation.latestMessageId,
      item_type: "conversation",
      category: categoryForDatabase,
      summary: analysis.summary,
      requires_attention: analysis.requiresAttention,
      confidence: analysis.confidence,
      suggested_reply: analysis.suggestedReply,
      received_at: conversation.latestMessageAt,
      is_meeting_invitation: analysis.isMeetingInvitation,
      requested_action: defaultActionsForCategory(analysis.category, analysis.isMeetingInvitation),
      recommended_action: defaultActionsForCategory(analysis.category, analysis.isMeetingInvitation),
      selected_action_source: "default",
    })
    .select(
      "id, conversation_id, category, requested_action, recommended_action, suggested_reply, is_meeting_invitation, review_state"
    )
    .single();

  if (conversationError || !mailroomConversation) {
    await supabaseServer
      .from("mailroom_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: conversationError?.message ?? "Unknown error",
      })
      .eq("id", run.id);
    throw new Error(`Could not persist reconstructed Mailroom analysis: ${conversationError?.message ?? "Unknown error"}`);
  }

  await supabaseServer
    .from("mailroom_runs")
    .update({ status: "ready_for_review", completed_at: new Date().toISOString() })
    .eq("id", run.id);

  // Same reasoning as the batch loop in runMailroomAnalysis: without this,
  // the next scheduled maintenance cycle would see this conversation's
  // Inbox messages as still unprocessed and re-analyze/re-insert it again.
  const { error: markProcessedError } = await supabaseServer
    .from("emails")
    .update({ processed: true })
    .in("outlook_message_id", conversation.inboxMessageIds);

  if (markProcessedError) {
    throw new Error(
      `Reconstructed analysis for "${conversation.subject}" but could not mark its Inbox messages processed: ${markProcessedError.message}`
    );
  }

  return {
    mailroomConversationId: mailroomConversation.id as string,
    conversation: mailroomConversation as ReconstructedMailroomAnalysis["conversation"],
  };
}
