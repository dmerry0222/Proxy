import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import type {
  MailConversation,
  MailMessage,
  MailroomBucket,
  MailroomSystemType,
} from "@/lib/mailroom/types";
import {
  isActionableMeetingInvitation,
  normalizeOutlookMetadata,
  type OutlookHeader,
} from "@/lib/mailroom/normalizeOutlookMetadata";
import { defaultRequestedAction } from "@/lib/mailroom/actionModel";

const MAILBOX_OWNER_EMAIL = "dmerry@suffolk.edu";

type EmailRow = {
  outlook_message_id: string;
  conversation_id: string | null;
  direction: string;
  folder: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  body_preview: string | null;
  body_html: string | null;
  message_at: string | null;
  received_at: string | null;
  is_read: boolean | null;
  is_in_inbox: boolean | null;
  processed: boolean | null;
  internet_message_headers: OutlookHeader[] | null;
  is_calendar_related: boolean | null;
  calendar_message_kind: string | null;
  calendar_action: string | null;
  calendar_series_instance_id: string | null;
  to_recipients: string[] | null;
  cc_recipients: string[] | null;
  is_auto_reply: boolean | null;
  is_mailing_list: boolean | null;
  is_system_generated: boolean | null;
  list_id: string | null;
};

function toMailMessage(
  row: EmailRow
): MailMessage {
  const normalized = normalizeOutlookMetadata({
    headers: row.internet_message_headers,
    subject: row.subject,
    body: row.body_html,
    bodyPreview: row.body_preview,
  });
  return {
    outlookMessageId:
      row.outlook_message_id,

    conversationId:
      row.conversation_id ||
      row.outlook_message_id,

    direction:
      row.direction,

    folder:
      row.folder,

    fromName:
      row.from_name,

    fromEmail:
      row.from_email,

    subject:
      row.subject,

    bodyPreview:
      row.body_preview,

    bodyHtml:
      row.body_html,

    messageAt:
      row.message_at,

    receivedAt:
      row.received_at,

    isRead:
      row.is_read,
     
      isInInbox:
  row.is_in_inbox,

  processed:
  row.processed,
    isCalendarRelated: row.is_calendar_related === true || normalized.isCalendarRelated,
    calendarMessageKind: row.calendar_message_kind ?? normalized.calendarMessageKind,
    calendarAction: row.calendar_action ?? normalized.calendarAction,
    calendarSeriesInstanceId: row.calendar_series_instance_id ?? normalized.calendarSeriesInstanceId,
    isMeetingForward: normalized.isMeetingForward,
    toRecipients: row.to_recipients ?? [],
    ccRecipients: row.cc_recipients ?? [],
    isAutoReply: row.is_auto_reply === true || normalized.isAutoReply,
    isMailingList: row.is_mailing_list === true || normalized.isMailingList,
    isSystemGenerated: row.is_system_generated === true || normalized.isSystemGenerated,
    listId: row.list_id ?? normalized.listId,
  };
}

export function normalizeSubject(
  subject: string | null
): string {
  if (!subject) {
    return "(No subject)";
  }

  let normalized =
    subject.trim();

  const prefixes = [
    /^\s*\[external\]\s*/i,
    /^\s*\[secure\]\s*/i,
    /^\s*\[spam\]\s*/i,

    /^\s*re:\s*/i,
    /^\s*fw:\s*/i,
    /^\s*fwd:\s*/i,

    /^\s*automatic reply:\s*/i,
    /^\s*auto reply:\s*/i,
    /^\s*out of office:\s*/i,
    /^\s*out-of-office:\s*/i,
  ];

  let changed = true;

  while (changed) {
    changed = false;

    for (
      const pattern
      of prefixes
    ) {
      const updated =
        normalized.replace(
          pattern,
          ""
        );

      if (
        updated !==
        normalized
      ) {
        normalized =
          updated.trim();

        changed = true;
      }
    }
  }

  return (
    normalized ||
    "(No subject)"
  );
}

export function isSystemNoise(
  message: MailMessage
): boolean {
  const rawSubject =
    message.subject
      ?.trim()
      .toLowerCase() ??
    "";

  const normalizedSubject =
    normalizeSubject(
      message.subject
    )
      .trim()
      .toLowerCase();

  const sender =
    message.fromEmail
      ?.trim()
      .toLowerCase() ??
    "";

  return (
    message.isAutoReply ||
    message.isCalendarRelated ||
    rawSubject.startsWith(
      "automatic reply:"
    ) ||
    rawSubject.startsWith(
      "auto reply:"
    ) ||
    rawSubject.startsWith(
      "out of office:"
    ) ||
    rawSubject.startsWith(
      "out-of-office:"
    ) ||

    rawSubject.startsWith(
      "accepted:"
    ) ||
    rawSubject.startsWith(
      "declined:"
    ) ||
    rawSubject.startsWith(
      "tentative:"
    ) ||
    rawSubject.startsWith(
      "canceled:"
    ) ||
    rawSubject.startsWith(
      "cancelled:"
    ) ||

    normalizedSubject.startsWith(
      "accepted:"
    ) ||
    normalizedSubject.startsWith(
      "declined:"
    ) ||
    normalizedSubject.startsWith(
      "tentative:"
    ) ||
    normalizedSubject.startsWith(
      "canceled:"
    ) ||
    normalizedSubject.startsWith(
      "cancelled:"
    ) ||

    rawSubject.includes(
      "delivery status notification"
    ) ||
    rawSubject.includes(
      "delivery failure"
    ) ||
    rawSubject.includes(
      "undeliverable:"
    ) ||

    sender.includes(
      "mailer-daemon"
    ) ||
    sender.includes(
      "postmaster"
    )
  );
}

function getMessageSystemType(
  message: MailMessage
): MailroomSystemType | null {
  const sender =
    message.fromEmail
      ?.trim()
      .toLowerCase() ??
    "";

  const rawSubject =
    message.subject
      ?.trim()
      .toLowerCase() ??
    "";

  const normalizedSubject =
    normalizeSubject(
      message.subject
    )
      .trim()
      .toLowerCase();

  const bodyText =
    [
      message.bodyPreview,
      message.bodyHtml,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

  if (message.isCalendarRelated) {
    return message.calendarAction || message.calendarMessageKind === "cancellation"
      ? "calendar_response"
      : "meeting_request";
  }

  if (
    sender ===
      "suffolk@myworkday.com" ||
    sender.endsWith(
      "@myworkday.com"
    )
  ) {
    return "workday";
  }

  if (
    rawSubject.startsWith(
      "accepted:"
    ) ||
    rawSubject.startsWith(
      "declined:"
    ) ||
    rawSubject.startsWith(
      "tentative:"
    ) ||
    rawSubject.startsWith(
      "canceled:"
    ) ||
    rawSubject.startsWith(
      "cancelled:"
    ) ||
    rawSubject.includes(
      "proposed new time"
    ) ||

    normalizedSubject.startsWith(
      "accepted:"
    ) ||
    normalizedSubject.startsWith(
      "declined:"
    ) ||
    normalizedSubject.startsWith(
      "tentative:"
    ) ||
    normalizedSubject.startsWith(
      "canceled:"
    ) ||
    normalizedSubject.startsWith(
      "cancelled:"
    ) ||
    normalizedSubject.includes(
      "proposed new time"
    )
  ) {
    return "calendar_response";
  }

  if (
    normalizedSubject.startsWith(
      "invitation:"
    ) ||
    normalizedSubject.startsWith(
      "meeting request:"
    ) ||
    normalizedSubject.includes(
      "invited you to"
    )
  ) {
    return "meeting_request";
  }

  const looksLikeZoomInvite =
    bodyText.includes(
      "is inviting you to a scheduled zoom meeting"
    ) ||
    (
      bodyText.includes(
        "join zoom meeting"
      ) &&
      bodyText.includes(
        "meeting url"
      )
    );

  const looksLikeTeamsInvite =
    bodyText.includes(
      "join microsoft teams meeting"
    ) ||
    (
      bodyText.includes(
        "join the meeting now"
      ) &&
      bodyText.includes(
        "meeting id"
      )
    ) ||
    (
      bodyText.includes(
        "microsoft teams meeting"
      ) &&
      bodyText.includes(
        "join"
      )
    );

  const looksLikeGenericInvite =
    bodyText.includes(
      "you have been invited to"
    ) ||
    bodyText.includes(
      "has invited you to"
    );

  if (
    looksLikeZoomInvite ||
    looksLikeTeamsInvite ||
    looksLikeGenericInvite
  ) {
    return "meeting_request";
  }

  return null;
}

function getConversationSystemType(
  messages: MailMessage[]
): MailroomSystemType | null {
  const inboxMessages =
    messages.filter(
      (message) =>
        message.isInInbox ===
        true
    );

  if (
    inboxMessages.some(
      (message) =>
        getMessageSystemType(
          message
        ) ===
        "meeting_request"
    )
  ) {
    return "meeting_request";
  }

  if (
    inboxMessages.some(
      (message) =>
        getMessageSystemType(
          message
        ) ===
        "workday"
    )
  ) {
    return "workday";
  }

  if (
    inboxMessages.some(
      (message) =>
        getMessageSystemType(
          message
        ) ===
        "calendar_response"
    )
  ) {
    return "calendar_response";
  }

  return null;
}

function temporaryBucket(
  message: MailMessage
): MailroomBucket {
  const sender =
    message.fromEmail
      ?.toLowerCase() ??
    "";

  if (sender === "suffolk@myworkday.com" || sender.endsWith("@myworkday.com")) {
    return "Workday";
  }

  if (message.isCalendarRelated) {
    return "Calendar";
  }

  if (message.isAutoReply) {
    return "Low Value";
  }

  const subject =
    message.subject
      ?.toLowerCase() ??
    "";

  if (
    sender.endsWith(
      "@suffolk.edu"
    )
  ) {
    return "Needs You";
  }

  if (
    sender.includes(
      "chronicle"
    ) ||
    sender.includes(
      "insidehighered"
    ) ||
    sender.includes(
      "aacu"
    ) ||
    sender.includes(
      "cael"
    ) ||
    sender.includes(
      "handshake"
    )
  ) {
    return "Professional News";
  }

  if (
    subject.includes(
      "save $"
    ) ||
    subject.includes(
      "register now"
    ) ||
    subject.includes(
      "last chance"
    ) ||
    subject.includes(
      "win $"
    ) ||
    subject.includes(
      "special offer"
    )
  ) {
    return "Low Value";
  }

  return "FYI";
}

function getMessageTime(
  message: MailMessage
): number {
  if (!message.messageAt) {
    return 0;
  }

  return new Date(
    message.messageAt
  ).getTime();
}

const BUCKET_TO_CATEGORY: Record<MailroomBucket, "needs_you" | "fyi" | "professional_news" | "low_value" | "calendar" | "workday"> = {
  "Needs You": "needs_you",
  FYI: "fyi",
  "Professional News": "professional_news",
  "Low Value": "low_value",
  Calendar: "calendar",
  Workday: "workday",
};

type LoadMailroomOptions = {
  includeProcessed?: boolean;
  limit?: number;
};

export async function loadMailroomConversations(
  options: LoadMailroomOptions = {}
): Promise<
  MailConversation[]
> {
  const {
    includeProcessed = false,
    limit = 50,
  } = options;
  const baseInboxQuery =
    supabaseServer
      .from("emails")
      .select(
        `
        outlook_message_id,
        conversation_id,
        direction,
        folder,
        from_name,
        from_email,
        subject,
        body_preview,
        body_html,
        message_at,
        received_at,
        is_read,
        is_in_inbox,
        processed
        ,internet_message_headers
        ,is_calendar_related
        ,calendar_message_kind
        ,calendar_action
        ,calendar_series_instance_id
        ,to_recipients
        ,cc_recipients
        ,is_auto_reply
        ,is_mailing_list
        ,is_system_generated
        ,list_id
        `
      )
      .eq(
        "is_in_inbox",
        true
      );

  const inboxQuery =
    includeProcessed
      ? baseInboxQuery
      : baseInboxQuery.eq(
          "processed",
          false
        );

  const {
    data: inboxRows,
    error: inboxError,
  } =
    await inboxQuery
      .order(
        "message_at",
        {
          ascending:
            false,
        }
      )
      .limit(limit);

  if (inboxError) {
    throw new Error(
      `Could not load inbox: ${inboxError.message}`
    );
  }

  if (
    !inboxRows ||
    inboxRows.length === 0
  ) {
    return [];
  }

  const conversationIds = [
    ...new Set(
      inboxRows
        .map(
          (row) =>
            row.conversation_id
        )
        .filter(
          (
            id
          ): id is string =>
            typeof id ===
              "string" &&
            id.length >
              0
        )
    ),
  ];

  let allRows: EmailRow[] =
    inboxRows as EmailRow[];

  if (
    conversationIds.length >
    0
  ) {
    const {
      data:
        threadRows,
      error:
        threadError,
    } =
      await supabaseServer
        .from(
          "emails"
        )
        .select(
          `
          outlook_message_id,
          conversation_id,
          direction,
          folder,
          from_name,
          from_email,
          subject,
          body_preview,
          body_html,
          message_at,
          received_at,
          is_read,
          is_in_inbox,
          processed
          ,internet_message_headers
          ,is_calendar_related
          ,calendar_message_kind
          ,calendar_action
          ,calendar_series_instance_id
          ,to_recipients
          ,cc_recipients
          ,is_auto_reply
          ,is_mailing_list
          ,is_system_generated
          ,list_id
          `
        )
        .in(
          "conversation_id",
          conversationIds
        )
        .order(
          "message_at",
          {
            ascending:
              true,
          }
        );

    if (threadError) {
      throw new Error(
        `Could not load conversation history: ${threadError.message}`
      );
    }

    if (threadRows) {
      allRows =
        threadRows as EmailRow[];
    }
  }

  const grouped =
    new Map<
      string,
      MailMessage[]
    >();

  for (
    const row
    of allRows
  ) {
    const message =
      toMailMessage(
        row
      );

    const conversationId =
      message.conversationId;

    const existing =
      grouped.get(
        conversationId
      ) ?? [];

    existing.push(
      message
    );

    grouped.set(
      conversationId,
      existing
    );
  }

  const conversations:
    MailConversation[] =
      [];

  for (
    const [
      conversationId,
      messages,
    ]
    of grouped
  ) {
    const sortedMessages =
      [...messages].sort(
        (
          a,
          b
        ) =>
          getMessageTime(
            a
          ) -
          getMessageTime(
            b
          )
      );

    const inboxMessages =
      sortedMessages.filter(
        (message) =>
          message.isInInbox ===
          true
      );

    if (
      inboxMessages.length ===
      0
    ) {
      continue;
    }

    const latestMessage =
      sortedMessages[
        sortedMessages.length -
          1
      ];

    const latestIncoming =
      [...sortedMessages]
        .reverse()
        .find(
          (message) =>
            message.direction.toLowerCase() ===
            "incoming"
        ) ??
      latestMessage;

    const latestSubstantiveIncoming =
      [...sortedMessages]
        .reverse()
        .find(
          (message) =>
            message.direction.toLowerCase() ===
              "incoming" &&
            !isSystemNoise(
              message
            )
        ) ??
      null;

    const representativeMessage =
      latestSubstantiveIncoming ??
      latestIncoming ??
      latestMessage;

    const incomingMessages = sortedMessages.filter((message) =>
      message.direction.toLowerCase() === "incoming");
    const isCalendarRelated = inboxMessages.some((message) => message.isCalendarRelated);
    const isMailingList = incomingMessages.some((message) => message.isMailingList);
    const listId = [...incomingMessages].reverse().find((message) => message.listId)?.listId ?? null;
    const isAutoReply = incomingMessages.length > 0 &&
      incomingMessages.every((message) => message.isAutoReply || message.isCalendarRelated);

    const bucket =
      temporaryBucket(
        representativeMessage
      );

    /*
     * Accept Invite eligibility is decided ONLY by the deterministic
     * structural predicate. The previous check (kind === "meeting_message"
     * && !action) had real false positives in this mailbox: forwarded
     * meeting mail carries identical calendar headers.
     */
    const isMeetingInvitation = isActionableMeetingInvitation(
      {
        calendarMessageKind: latestMessage.calendarMessageKind as
          | "meeting_response"
          | "meeting_message"
          | "cancellation"
          | null,
        calendarAction: latestMessage.calendarAction as
          | "accepted"
          | "declined"
          | "tentative"
          | "cancelled"
          | null,
        calendarSeriesInstanceId: latestMessage.calendarSeriesInstanceId,
        isMeetingForward: latestMessage.isMeetingForward,
        direction: latestMessage.direction,
        subject: latestMessage.subject,
        toRecipients: latestMessage.toRecipients,
        ccRecipients: latestMessage.ccRecipients,
        isInInbox: latestMessage.isInInbox,
      },
      MAILBOX_OWNER_EMAIL
    );

    const requestedAction =
      defaultRequestedAction(BUCKET_TO_CATEGORY[bucket], isMeetingInvitation);

    conversations.push({
      conversationId,

      subject:
        normalizeSubject(
          representativeMessage.subject
        ),

      senderName:
        representativeMessage.fromName,

      senderEmail:
        representativeMessage.fromEmail,

      latestMessageId:
        latestMessage.outlookMessageId,

      latestSubstantiveMessageId:
        latestSubstantiveIncoming
          ?.outlookMessageId ??
        null,

      latestMessageAt:
        latestMessage.messageAt,

      messages:
        sortedMessages,

      inboxMessageIds:
        inboxMessages.map(
          (message) =>
            message.outlookMessageId
        ),

      hasUnprocessedInboxMessages:
        inboxMessages.some(
          (message) =>
            message.processed !==
            true
        ),

      systemType:
        getConversationSystemType(
          sortedMessages
        ),

      isCalendarRelated,
      isAutoReply,
      isMailingList,
      listId,

      bucket,

      summary:
        representativeMessage.bodyPreview ||
        "No preview available.",

      requestedAction,

      isMeetingInvitation,

      feedback:
        "",
    });
  }

  conversations.sort(
    (
      a,
      b
    ) => {
      const aTime =
        a.latestMessageAt
          ? new Date(
              a.latestMessageAt
            ).getTime()
          : 0;

      const bTime =
        b.latestMessageAt
          ? new Date(
              b.latestMessageAt
            ).getTime()
          : 0;

      return (
        bTime -
        aTime
      );
    }
  );

  return conversations;
}

/**
 * Loads and rebuilds a single conversation directly from `emails`, by
 * Outlook conversation id, independent of the inbox/`processed` batch
 * windowing that `loadMailroomConversations` applies. Used to reconstruct a
 * Mailroom analysis for a conversation whose mailroom_conversations row is
 * missing (e.g. purged) but whose underlying email still exists -- including
 * a conversation that has since been archived out of the inbox entirely, so
 * this deliberately does NOT require any inbox messages to exist.
 */
export async function loadMailroomConversationByConversationId(
  conversationId: string
): Promise<MailConversation | null> {
  const { data: rows, error } = await supabaseServer
    .from("emails")
    .select(
      `
      outlook_message_id,
      conversation_id,
      direction,
      folder,
      from_name,
      from_email,
      subject,
      body_preview,
      body_html,
      message_at,
      received_at,
      is_read,
      is_in_inbox,
      processed
      ,internet_message_headers
      ,is_calendar_related
      ,calendar_message_kind
      ,calendar_action
      ,calendar_series_instance_id
      ,to_recipients
      ,cc_recipients
      ,is_auto_reply
      ,is_mailing_list
      ,is_system_generated
      ,list_id
      `
    )
    .eq("conversation_id", conversationId);

  if (error) {
    throw new Error(`Could not load conversation ${conversationId} for Mailroom reconstruction: ${error.message}`);
  }

  if (!rows || rows.length === 0) {
    return null;
  }

  const sortedMessages = (rows as EmailRow[])
    .map(toMailMessage)
    .sort((a, b) => getMessageTime(a) - getMessageTime(b));

  const inboxMessages = sortedMessages.filter((message) => message.isInInbox === true);

  const latestMessage = sortedMessages[sortedMessages.length - 1];

  const latestIncoming =
    [...sortedMessages].reverse().find((message) => message.direction.toLowerCase() === "incoming") ?? latestMessage;

  const latestSubstantiveIncoming =
    [...sortedMessages]
      .reverse()
      .find((message) => message.direction.toLowerCase() === "incoming" && !isSystemNoise(message)) ?? null;

  const representativeMessage = latestSubstantiveIncoming ?? latestIncoming ?? latestMessage;

  const incomingMessages = sortedMessages.filter((message) => message.direction.toLowerCase() === "incoming");
  const isCalendarRelated = sortedMessages.some((message) => message.isCalendarRelated);
  const isMailingList = incomingMessages.some((message) => message.isMailingList);
  const listId = [...incomingMessages].reverse().find((message) => message.listId)?.listId ?? null;
  const isAutoReply =
    incomingMessages.length > 0 && incomingMessages.every((message) => message.isAutoReply || message.isCalendarRelated);

  const bucket = temporaryBucket(representativeMessage);

  const isMeetingInvitation = isActionableMeetingInvitation(
    {
      calendarMessageKind: latestMessage.calendarMessageKind as
        | "meeting_response"
        | "meeting_message"
        | "cancellation"
        | null,
      calendarAction: latestMessage.calendarAction as "accepted" | "declined" | "tentative" | "cancelled" | null,
      calendarSeriesInstanceId: latestMessage.calendarSeriesInstanceId,
      isMeetingForward: latestMessage.isMeetingForward,
      direction: latestMessage.direction,
      subject: latestMessage.subject,
      toRecipients: latestMessage.toRecipients,
      ccRecipients: latestMessage.ccRecipients,
      isInInbox: latestMessage.isInInbox,
    },
    MAILBOX_OWNER_EMAIL
  );

  const requestedAction = defaultRequestedAction(BUCKET_TO_CATEGORY[bucket], isMeetingInvitation);

  return {
    conversationId,
    subject: normalizeSubject(representativeMessage.subject),
    senderName: representativeMessage.fromName,
    senderEmail: representativeMessage.fromEmail,
    latestMessageId: latestMessage.outlookMessageId,
    latestSubstantiveMessageId: latestSubstantiveIncoming?.outlookMessageId ?? null,
    latestMessageAt: latestMessage.messageAt,
    messages: sortedMessages,
    inboxMessageIds: inboxMessages.map((message) => message.outlookMessageId),
    hasUnprocessedInboxMessages: inboxMessages.some((message) => message.processed !== true),
    systemType: getConversationSystemType(sortedMessages),
    isCalendarRelated,
    isAutoReply,
    isMailingList,
    listId,
    bucket,
    summary: representativeMessage.bodyPreview || "No preview available.",
    requestedAction,
    isMeetingInvitation,
    feedback: "",
  };
}
