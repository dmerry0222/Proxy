import type { RequestedAction } from "@/lib/mailroom/actionModel";

export type MailroomBucket =
  | "Needs You"
  | "FYI"
  | "Professional News"
  | "Low Value"
  | "Calendar"
  | "Workday";

export type MailroomSystemType =
  | "workday"
  | "calendar_response"
  | "meeting_request";

export type MailMessage = {
  outlookMessageId: string;
  conversationId: string;
  direction: string;
  folder: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  bodyPreview: string | null;
  bodyHtml: string | null;
  messageAt: string | null;
  receivedAt: string | null;
  isRead: boolean | null;
  isInInbox: boolean | null;
  processed: boolean | null;
  isCalendarRelated: boolean;
  calendarMessageKind: string | null;
  calendarAction: string | null;
  calendarSeriesInstanceId: string | null;
  isMeetingForward: boolean;
  toRecipients: string[];
  ccRecipients: string[];
  isAutoReply: boolean;
  isMailingList: boolean;
  isSystemGenerated: boolean;
  listId: string | null;
};

export type MailConversation = {
  conversationId: string;

  systemType?:
    | MailroomSystemType
    | null;

  isCalendarRelated: boolean;
  isAutoReply: boolean;
  isMailingList: boolean;
  listId: string | null;

  subject: string;

  senderName:
    | string
    | null;

  senderEmail:
    | string
    | null;

  latestMessageId:
    string;

  latestSubstantiveMessageId:
    | string
    | null;

  latestMessageAt:
    | string
    | null;

  messages:
    MailMessage[];

  inboxMessageIds:
    string[];

  hasUnprocessedInboxMessages:
    boolean;

  bucket:
    MailroomBucket;

  summary:
    string;

  requestedAction:
    RequestedAction;

  isMeetingInvitation:
    boolean;

  feedback:
    string;
};
