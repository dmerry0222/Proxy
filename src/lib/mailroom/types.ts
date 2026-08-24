export type MailroomBucket =
  | "Needs You"
  | "FYI"
  | "Professional News"
  | "Low Value";

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
};

export type MailConversation = {
  conversationId: string;

  systemType?:
    | MailroomSystemType
    | null;

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

  needsAction:
    boolean;

  archive:
    boolean;

  feedback:
    string;
};