/**
 * Canonical Mailroom category + requested-action model (Build: "Mailroom
 * Action Model + Notion Surface + Power Automate Execution"). Pure,
 * zero-import leaf module -- no DB/API calls, so it's directly unit
 * testable and safely shared by analyzeMailroom.ts, the review UI, the
 * Notion projection, and the Notion->Proxy intake route, keeping "what's
 * the default for X" and "is this action even valid" defined in exactly
 * one place.
 */

export type MailroomCategory = "needs_you" | "fyi" | "professional_news" | "low_value" | "calendar" | "workday";

export type RequestedAction = "archive" | "needs_attention" | "draft_reply" | "accept_invite" | "none";

export const MAILROOM_CATEGORIES: MailroomCategory[] = ["needs_you", "fyi", "professional_news", "low_value", "calendar", "workday"];
export const REQUESTED_ACTIONS: RequestedAction[] = ["archive", "needs_attention", "draft_reply", "accept_invite", "none"];

export const CATEGORY_LABELS: Record<MailroomCategory, string> = {
  needs_you: "Needs You",
  fyi: "FYI",
  professional_news: "Professional News",
  low_value: "Low Value",
  calendar: "Calendar",
  workday: "Workday",
};

export const ACTION_LABELS: Record<RequestedAction, string> = {
  archive: "Archive",
  needs_attention: "Needs Attention",
  draft_reply: "Draft Reply",
  accept_invite: "Accept Invite",
  none: "None",
};

export function isMailroomCategory(value: unknown): value is MailroomCategory {
  return typeof value === "string" && (MAILROOM_CATEGORIES as string[]).includes(value);
}

export function isRequestedAction(value: unknown): value is RequestedAction {
  return typeof value === "string" && (REQUESTED_ACTIONS as string[]).includes(value);
}

/**
 * Post-Phase brief Part 6 -- classification sets a sensible default, but
 * it is never auto-executed; this is the recommendation only. Preserves
 * the pre-existing needsAction/archive defaults exactly for the four
 * original buckets (Needs You -> what is now "needs_attention"; the other
 * three -> "archive"), and adds the two new ones.
 */
export function defaultRequestedAction(category: MailroomCategory, isMeetingInvitation: boolean): RequestedAction {
  switch (category) {
    case "needs_you":
      return "needs_attention";
    case "fyi":
    case "professional_news":
    case "low_value":
      return "archive";
    case "calendar":
      return isMeetingInvitation ? "accept_invite" : "archive";
    case "workday":
      return "archive";
  }
}

/**
 * The one safety gate for accept_invite (Part 4/17): valid only for a
 * conversation deterministically identified as an actual meeting
 * invitation. Never bypassable by category alone -- a "Calendar" item
 * that isn't a positively-identified invitation cannot accept_invite.
 */
export function isActionValidForItem(action: RequestedAction, isMeetingInvitation: boolean): { valid: boolean; reason?: string } {
  if (!isRequestedAction(action)) return { valid: false, reason: `Unknown action: ${String(action)}` };
  if (action === "accept_invite" && !isMeetingInvitation) {
    return { valid: false, reason: "accept_invite is only valid for a positively identified meeting invitation." };
  }
  return { valid: true };
}

/**
 * The identity of an execution command: (actionable message, action).
 * Deliberately NOT keyed on conversation -- a conversation receives new
 * messages over time and the same action on a newer message is a new,
 * legitimate command. `internetMessageId` (RFC 5322 Message-ID) is
 * preferred because it is immutable across the folder moves these actions
 * perform, unlike the Graph/EWS message id which changes on move.
 */
export function mailroomCommandIdentity(input: {
  internetMessageId: string | null;
  outlookMessageId: string;
  action: RequestedAction;
}): string {
  const messageIdentity = input.internetMessageId ?? input.outlookMessageId;
  return `mailroom:${messageIdentity}:${input.action}`;
}

/** Which actions the UI/Notion should offer for a given item (Part 7/8). */
export function availableActions(isMeetingInvitation: boolean): RequestedAction[] {
  return isMeetingInvitation
    ? ["archive", "needs_attention", "draft_reply", "accept_invite"]
    : ["archive", "needs_attention", "draft_reply"];
}
