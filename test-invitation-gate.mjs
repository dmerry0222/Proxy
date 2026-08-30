import test from "node:test";
import assert from "node:assert/strict";
import {
  isActionableMeetingInvitation,
  normalizeOutlookMetadata,
} from "./src/lib/mailroom/normalizeOutlookMetadata.ts";

const DAVE = "dmerry@suffolk.edu";

// Structurally representative of real mail observed in this mailbox.
const CAL_HEADERS = [
  { name: "X-MS-Exchange-Calendar-Series-Instance-Id", value: "BAAAAIIA4AB0xbcQGoLgCAAAAAALNHTMPjbdAQAAAAAAAAAAEA" },
  { name: "X-MS-Exchange-Calendar-Originator-Id", value: "e7426284-96dc-491f-a000-000000000000;/o=ExchangeLabs" },
];

function candidate(overrides = {}) {
  return {
    calendarMessageKind: "meeting_message",
    calendarAction: null,
    calendarSeriesInstanceId: "BAAAAIIA4AB0xbcQ",
    isMeetingForward: false,
    direction: "Incoming",
    subject: "Career Plan Updates",
    toRecipients: ["kaborn@suffolk.edu;dmerry@suffolk.edu"],
    ccRecipients: [],
    isInInbox: true,
    ...overrides,
  };
}

test("TRUE INVITATION: organizer-sent meeting message addressed to Dave is acceptable", () => {
  assert.equal(isActionableMeetingInvitation(candidate(), DAVE), true);
});

test("FORWARDED INVITE: X-MS-Exchange-MeetingForward-Message blocks Accept Invite", () => {
  // Real regression: forwarded meeting mail carries the SAME calendar
  // headers (even the same series-instance-id) as the true invitation.
  assert.equal(isActionableMeetingInvitation(candidate({ isMeetingForward: true }), DAVE), false);
});

test("FORWARDED INVITE: the header is detected structurally by the normalizer", () => {
  const normalized = normalizeOutlookMetadata({
    headers: [...CAL_HEADERS, { name: "X-MS-Exchange-MeetingForward-Message", value: "Forward" }],
    subject: "FW: Career Plan Discussion",
  });
  assert.equal(normalized.isMeetingForward, true);
  assert.equal(normalized.isCalendarRelated, true);
});

test("FORWARDED INVITE: FW: subject is blocked even if the header were missing", () => {
  assert.equal(
    isActionableMeetingInvitation(candidate({ subject: "FW: Career Plan Discussion" }), DAVE),
    false
  );
});

test("CANCELLATION: a cancelled meeting is never acceptable", () => {
  const normalized = normalizeOutlookMetadata({ headers: CAL_HEADERS, subject: "Canceled: Ade and Aki" });
  assert.equal(normalized.calendarMessageKind, "cancellation");
  assert.equal(normalized.calendarAction, "cancelled");
  assert.equal(
    isActionableMeetingInvitation(
      candidate({ calendarMessageKind: "cancellation", calendarAction: "cancelled", subject: "Canceled: Ade and Aki" }),
      DAVE
    ),
    false
  );
});

test("RESPONSE: accepted/declined/tentative replies are never acceptable", () => {
  for (const [subject, action] of [
    ["Accepted: Directors' Meeting", "accepted"],
    ["Declined: Approval Tool Deep-dive", "declined"],
    ["Tentative: Directors' Meeting", "tentative"],
  ]) {
    const normalized = normalizeOutlookMetadata({ headers: CAL_HEADERS, subject });
    assert.equal(normalized.calendarMessageKind, "meeting_response", subject);
    assert.equal(normalized.calendarAction, action, subject);
    assert.equal(
      isActionableMeetingInvitation(
        candidate({ calendarMessageKind: "meeting_response", calendarAction: action, subject }),
        DAVE
      ),
      false,
      subject
    );
  }
});

test("UPDATE/RESCHEDULE: an update is accepted like an invitation (documented limitation)", () => {
  // Updates are structurally indistinguishable from new invitations with
  // currently-stored fields. Re-accepting an update is benign in Graph, so
  // this is deliberately allowed rather than silently mis-blocked.
  assert.equal(isActionableMeetingInvitation(candidate({ subject: "Updated: Career Plan Updates" }), DAVE), true);
});

test("INFORMATIONAL: a calendar-ish message with no real calendar header is not acceptable", () => {
  assert.equal(isActionableMeetingInvitation(candidate({ calendarSeriesInstanceId: null }), DAVE), false);
});

test("NOT ADDRESSED TO DAVE: an invitation to someone else is not acceptable", () => {
  assert.equal(
    isActionableMeetingInvitation(candidate({ toRecipients: ["someone.else@suffolk.edu"], ccRecipients: [] }), DAVE),
    false
  );
});

test("Dave on CC still counts as addressed", () => {
  assert.equal(
    isActionableMeetingInvitation(
      candidate({ toRecipients: ["other@suffolk.edu"], ccRecipients: ["dmerry@suffolk.edu"] }),
      DAVE
    ),
    true
  );
});

test("OUTGOING: a meeting Dave sent is not acceptable", () => {
  assert.equal(isActionableMeetingInvitation(candidate({ direction: "Outgoing" }), DAVE), false);
});

test("NOT IN INBOX: an already-filed invitation is not actionable", () => {
  assert.equal(isActionableMeetingInvitation(candidate({ isInInbox: false }), DAVE), false);
});

test("ORDINARY EMAIL: no calendar metadata at all is not acceptable", () => {
  const normalized = normalizeOutlookMetadata({ headers: [], subject: "Lunch tomorrow?" });
  assert.equal(normalized.isCalendarRelated, false);
  assert.equal(normalized.calendarMessageKind, null);
  assert.equal(
    isActionableMeetingInvitation(candidate({ calendarMessageKind: null, calendarSeriesInstanceId: null }), DAVE),
    false
  );
});
