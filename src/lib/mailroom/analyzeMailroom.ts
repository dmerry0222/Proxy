import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import {
  isSystemNoise,
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

import type {
  MailConversation,
  MailroomBucket,
} from "@/lib/mailroom/types";

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

        const normalizedSubject =
          normalizeSubject(
            message.subject
          );

        return [
          `MESSAGE ${index + 1}`,
          `Direction: ${message.direction}`,
          `From: ${sender}`,
          `Date: ${message.messageAt ?? "Unknown"}`,
          `Normalized subject: ${normalizedSubject}`,
          `Original subject: ${message.subject ?? "(No subject)"}`,
          noiseLabel,
          "",
          message.bodyPreview ??
            "(No message text available)",
        ].join("\n");
      }
    )
    .join(
      "\n\n---\n\n"
    );
}

function defaultActionsForCategory(
  category: MailroomBucket
) {
  const needsAction =
    category ===
    "Needs You";

  return {
    needsAction,

    archive:
      !needsAction,
  };
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
    typeof analysis.summary !==
    "string"
  ) {
    throw new Error(
      "Claude returned an invalid summary"
    );
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

      const mailroomConversationId =
        mailroomConversation.id;

      const latestInboxMessageId =
        [
          ...conversation.messages,
        ]
          .reverse()
          .find(
            (message) =>
              message.isInInbox ===
              true
          )
          ?.outlookMessageId ??
        null;

      const defaults =
        defaultActionsForCategory(
          analysis.category
        );

      const actionRows: {
        mailroom_conversation_id:
          string;

        outlook_message_id:
          string;

        action_type:
          string;

        proposed_value:
          boolean;
      }[] = [];

      /*
       * Older Inbox copies in the same
       * conversation are always archived.
       */
      for (
        const messageId
        of conversation.inboxMessageIds
      ) {
        if (
          messageId !==
          latestInboxMessageId
        ) {
          actionRows.push({
            mailroom_conversation_id:
              mailroomConversationId,

            outlook_message_id:
              messageId,

            action_type:
              "archive",

            proposed_value:
              true,
          });
        }
      }

      if (
        latestInboxMessageId
      ) {
        actionRows.push({
          mailroom_conversation_id:
            mailroomConversationId,

          outlook_message_id:
            latestInboxMessageId,

          action_type:
            "archive",

          proposed_value:
            defaults.archive,
        });

        actionRows.push({
          mailroom_conversation_id:
            mailroomConversationId,

          outlook_message_id:
            latestInboxMessageId,

          action_type:
            "needs_action",

          proposed_value:
            defaults.needsAction,
        });
      }

      if (
        actionRows.length >
        0
      ) {
        const {
          error:
            actionError,
        } =
          await supabaseServer
            .from(
              "mailroom_actions"
            )
            .insert(
              actionRows
            );

        if (
          actionError
        ) {
          throw new Error(
            `Could not save actions for "${conversation.subject}": ${actionError.message}`
          );
        }
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