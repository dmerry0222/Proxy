export type OutlookHeader = {
  name?: string | null;
  value?: string | null;
};

export type HeaderLookup = ReadonlyMap<string, readonly string[]>;

export type NormalizedOutlookMetadata = {
  isCalendarRelated: boolean;
  calendarMessageKind: "meeting_response" | "meeting_message" | "cancellation" | null;
  calendarAction: "accepted" | "declined" | "tentative" | "cancelled" | null;
  isAutoReply: boolean;
  isMailingList: boolean;
  isSystemGenerated: boolean;
  calendarSeriesInstanceId: string | null;
  calendarOriginatorId: string | null;
  /**
   * Exchange stamps X-MS-Exchange-MeetingForward-Message on meeting mail
   * that was FORWARDED rather than sent by the organizer. Such a message
   * carries the same calendar headers (even the same
   * Calendar-Series-Instance-Id) as the real invitation, so this header is
   * the only structural way to tell them apart -- observed on real mail in
   * this mailbox.
   */
  isMeetingForward: boolean;
  parentMessageId: string | null;
  listId: string | null;
  autoResponseSuppress: string | null;
};

function normalizeHeaderName(name: string) {
  return name.trim().toLowerCase();
}

export function createHeaderLookup(headers: readonly OutlookHeader[] | null | undefined): HeaderLookup {
  const values = new Map<string, string[]>();
  for (const header of headers ?? []) {
    if (typeof header?.name !== "string" || typeof header?.value !== "string") continue;
    const name = normalizeHeaderName(header.name);
    const value = header.value.trim();
    if (!name || !value) continue;
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return values;
}

function isHeaderLookup(value: HeaderLookup | readonly OutlookHeader[] | null | undefined): value is HeaderLookup {
  return value instanceof Map;
}

export function getHeader(headers: HeaderLookup | readonly OutlookHeader[] | null | undefined, name: string) {
  const lookup = isHeaderLookup(headers) ? headers : createHeaderLookup(headers);
  return lookup.get(normalizeHeaderName(name))?.[0] ?? null;
}

export function hasHeader(headers: HeaderLookup | readonly OutlookHeader[] | null | undefined, name: string) {
  const lookup = isHeaderLookup(headers) ? headers : createHeaderLookup(headers);
  return (lookup.get(normalizeHeaderName(name))?.length ?? 0) > 0;
}

export function headerContains(headers: HeaderLookup | readonly OutlookHeader[] | null | undefined,
  name: string, value: string) {
  const lookup = isHeaderLookup(headers) ? headers : createHeaderLookup(headers);
  const needle = value.toLowerCase();
  return (lookup.get(normalizeHeaderName(name)) ?? [])
    .some((candidate: string) => candidate.toLowerCase().includes(needle));
}

function calendarActionFromSubject(subject: string | null | undefined) {
  const match = subject?.trim().match(/^(accepted|declined|tentative|cancell?ed):/i);
  if (!match) return null;
  const action = match[1].toLowerCase();
  return action === "canceled" || action === "cancelled" ? "cancelled" : action as
    "accepted" | "declined" | "tentative";
}

export function normalizeOutlookMetadata({ headers, subject }: {
  headers?: readonly OutlookHeader[] | null;
  subject?: string | null;
  body?: string | null;
  bodyPreview?: string | null;
}): NormalizedOutlookMetadata {
  const lookup = createHeaderLookup(headers);
  const calendarSeriesInstanceId = getHeader(lookup, "x-ms-exchange-calendar-series-instance-id");
  const calendarOriginatorId = getHeader(lookup, "x-ms-exchange-calendar-originator-id");
  const calendarAction = calendarActionFromSubject(subject);
  const meetingDiagnostic = headerContains(lookup, "x-ms-traffictypediagnostic", "ee_meetingmessage");
  const hasCalendarHeader = Boolean(calendarSeriesInstanceId || calendarOriginatorId);
  const isCalendarRelated = Boolean(calendarAction || meetingDiagnostic || hasCalendarHeader);
  const isAutoReply = headerContains(lookup, "auto-submitted", "auto-generated") ||
    headerContains(lookup, "x-ms-exchange-generated-message-source", "mailbox rules agent");
  const listId = getHeader(lookup, "list-id");
  const isMailingList = headerContains(lookup, "precedence", "list") ||
    Boolean(listId) || hasHeader(lookup, "x-beenthere");

  return {
    isCalendarRelated,
    calendarMessageKind: calendarAction === "cancelled" ? "cancellation" :
      calendarAction ? "meeting_response" : isCalendarRelated ? "meeting_message" : null,
    calendarAction,
    isAutoReply,
    isMailingList,
    isSystemGenerated: isCalendarRelated || isAutoReply,
    calendarSeriesInstanceId,
    calendarOriginatorId,
    isMeetingForward: hasHeader(lookup, "x-ms-exchange-meetingforward-message"),
    parentMessageId: getHeader(lookup, "in-reply-to"),
    listId,
    autoResponseSuppress: getHeader(lookup, "x-auto-response-suppress"),
  };
}

export type InvitationCandidate = {
  calendarMessageKind: NormalizedOutlookMetadata["calendarMessageKind"];
  calendarAction: NormalizedOutlookMetadata["calendarAction"];
  calendarSeriesInstanceId: string | null;
  isMeetingForward: boolean;
  direction: string | null;
  subject: string | null;
  toRecipients: readonly string[] | null;
  ccRecipients: readonly string[] | null;
  isInInbox: boolean | null;
};

/**
 * THE deterministic gate for exposing/executing Accept Invite.
 *
 * `calendarMessageKind === "meeting_message"` is NOT an invitation signal:
 * it is the RESIDUAL bucket for "calendar-related, but the subject didn't
 * match an accepted/declined/tentative/cancelled prefix". In real mailbox
 * data it also contains forwarded meeting mail. Accepting on that basis
 * alone would have accepted meetings Dave was merely shown.
 *
 * Every condition below is structural (Graph field or Exchange header) or
 * an addressing fact. No AI/text inference participates -- the only
 * string test is a defense-in-depth FW:/FWD:/RE: subject check layered on
 * top of the authoritative MeetingForward header, never a substitute for it.
 *
 * KNOWN LIMIT (documented, not papered over): a meeting UPDATE/reschedule
 * is indistinguishable from a new invitation using currently-stored
 * fields -- both arrive as meeting_message with calendar headers and no
 * action. Accepting an update is benign (Graph re-accepts the same event),
 * so this is safe, but it means "new invitation" specifically cannot be
 * asserted. Distinguishing them would require persisting Graph's
 * `meetingMessageType`, which this pipeline does not currently ingest.
 */
export function isActionableMeetingInvitation(
  candidate: InvitationCandidate,
  ownerEmail: string
): boolean {
  // Must be the residual calendar kind with no response/cancellation action.
  if (candidate.calendarMessageKind !== "meeting_message") return false;
  if (candidate.calendarAction !== null) return false;

  // Must carry a real Exchange calendar header -- not merely inferred.
  if (!candidate.calendarSeriesInstanceId) return false;

  // Forwarded meeting mail is never acceptable: it shares the invitation's
  // calendar headers, so this header is the only thing separating them.
  if (candidate.isMeetingForward) return false;

  // Defense in depth behind the header check above.
  if (/^\s*(fw|fwd|re)\s*:/i.test(candidate.subject ?? "")) return false;

  // Dave must be an addressed recipient, and must not be the sender.
  if ((candidate.direction ?? "").toLowerCase() !== "incoming") return false;
  const recipients = [...(candidate.toRecipients ?? []), ...(candidate.ccRecipients ?? [])]
    .join(";")
    .toLowerCase();
  if (!recipients.includes(ownerEmail.toLowerCase())) return false;

  // Only a live Inbox message is actionable.
  return candidate.isInInbox === true;
}

export function hasRealAttachments(attachments: readonly { isInline?: boolean | null }[] | null | undefined) {
  return (attachments ?? []).some((attachment) => attachment?.isInline !== true);
}

export function deterministicMailroomRoute(metadata: Pick<NormalizedOutlookMetadata,
  "isCalendarRelated" | "isAutoReply">) {
  if (metadata.isCalendarRelated) return "calendar" as const;
  if (metadata.isAutoReply) return "low_value" as const;
  return null;
}
