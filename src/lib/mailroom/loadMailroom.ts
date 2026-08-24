import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import type {
  MailConversation,
  MailMessage,
  MailroomBucket,
  MailroomSystemType,
} from "@/lib/mailroom/types";

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
};

function toMailMessage(
  row: EmailRow
): MailMessage {
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

function defaultActionsForBucket(
  bucket: MailroomBucket
) {
  const needsAction =
    bucket === "Needs You";

  return {
    needsAction,
    archive:
      !needsAction,
  };
}

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

    const bucket =
      temporaryBucket(
        representativeMessage
      );

    const defaults =
      defaultActionsForBucket(
        bucket
      );

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

      bucket,

      summary:
        representativeMessage.bodyPreview ||
        "No preview available.",

      needsAction:
        defaults.needsAction,

      archive:
        defaults.archive,

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