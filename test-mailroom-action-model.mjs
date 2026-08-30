import test from "node:test";
import assert from "node:assert/strict";
import {
  isMailroomCategory,
  isRequestedAction,
  defaultRequestedAction,
  isActionValidForItem,
  availableActions,
  mailroomCommandIdentity,
} from "./src/lib/mailroom/actionModel.ts";

test("only supported requested-action values pass validation", () => {
  assert.equal(isRequestedAction("archive"), true);
  assert.equal(isRequestedAction("needs_attention"), true);
  assert.equal(isRequestedAction("draft_reply"), true);
  assert.equal(isRequestedAction("accept_invite"), true);
  assert.equal(isRequestedAction("none"), true);
  assert.equal(isRequestedAction("send_now"), false);
  assert.equal(isRequestedAction(123), false);
});

test("only supported categories pass validation", () => {
  assert.equal(isMailroomCategory("calendar"), true);
  assert.equal(isMailroomCategory("workday"), true);
  assert.equal(isMailroomCategory("needs_action"), false);
});

test("ordinary email cannot execute Accept Invite", () => {
  const result = isActionValidForItem("accept_invite", false);
  assert.equal(result.valid, false);
});

test("a positively identified invitation can execute Accept Invite", () => {
  const result = isActionValidForItem("accept_invite", true);
  assert.equal(result.valid, true);
});

test("unknown action is rejected outright", () => {
  const result = isActionValidForItem("send_now", true);
  assert.equal(result.valid, false);
});

test("Needs You defaults to Needs Attention (preserving prior needsAction=true convention)", () => {
  assert.equal(defaultRequestedAction("needs_you", false), "needs_attention");
});

test("FYI/Professional News/Low Value default to Archive (preserving prior archive-default convention)", () => {
  assert.equal(defaultRequestedAction("fyi", false), "archive");
  assert.equal(defaultRequestedAction("professional_news", false), "archive");
  assert.equal(defaultRequestedAction("low_value", false), "archive");
});

test("a calendar notification/update defaults to Archive", () => {
  assert.equal(defaultRequestedAction("calendar", false), "archive");
});

test("a positively identified meeting invitation defaults to Accept Invite", () => {
  assert.equal(defaultRequestedAction("calendar", true), "accept_invite");
});

test("Workday defaults to Archive", () => {
  assert.equal(defaultRequestedAction("workday", false), "archive");
});

test("ordinary mail is offered Archive/Needs Attention/Draft Reply but not Accept Invite", () => {
  const actions = availableActions(false);
  assert.deepEqual(actions, ["archive", "needs_attention", "draft_reply"]);
});

test("a meeting invitation is additionally offered Accept Invite", () => {
  const actions = availableActions(true);
  assert.deepEqual(actions, ["archive", "needs_attention", "draft_reply", "accept_invite"]);
});

// --- Command identity / idempotency scope ---

test("retrying the same action on the SAME message is idempotent", () => {
  const monday = mailroomCommandIdentity({
    internetMessageId: "<msg-A@contoso.com>",
    outlookMessageId: "AAMk-A",
    action: "draft_reply",
  });
  const retry = mailroomCommandIdentity({
    internetMessageId: "<msg-A@contoso.com>",
    outlookMessageId: "AAMk-A",
    action: "draft_reply",
  });
  assert.equal(monday, retry);
});

test("the same action on a NEWER message in the same conversation is a new command", () => {
  // Mon: conversation X / message A / draft_reply -> succeeded
  const monday = mailroomCommandIdentity({
    internetMessageId: "<msg-A@contoso.com>",
    outlookMessageId: "AAMk-A",
    action: "draft_reply",
  });
  // Thu: conversation X / message B / draft_reply -> must NOT be suppressed
  const thursday = mailroomCommandIdentity({
    internetMessageId: "<msg-B@contoso.com>",
    outlookMessageId: "AAMk-B",
    action: "draft_reply",
  });
  assert.notEqual(monday, thursday, "a new message in the same thread must produce a new command identity");
});

test("identity survives an Outlook folder move (Graph id changes, Message-ID does not)", () => {
  const beforeMove = mailroomCommandIdentity({
    internetMessageId: "<msg-A@contoso.com>",
    outlookMessageId: "AAMk-INBOX-A",
    action: "archive",
  });
  const afterMove = mailroomCommandIdentity({
    internetMessageId: "<msg-A@contoso.com>",
    outlookMessageId: "AAMk-ARCHIVE-A",
    action: "archive",
  });
  assert.equal(beforeMove, afterMove, "archiving changes the Graph id; identity must not change with it");
});

test("different actions on the same message are distinct commands", () => {
  const draft = mailroomCommandIdentity({ internetMessageId: "<a@b.com>", outlookMessageId: "X", action: "draft_reply" });
  const archive = mailroomCommandIdentity({ internetMessageId: "<a@b.com>", outlookMessageId: "X", action: "archive" });
  assert.notEqual(draft, archive);
});

test("identity falls back to the Graph id when Message-ID is unavailable", () => {
  const identity = mailroomCommandIdentity({ internetMessageId: null, outlookMessageId: "AAMk-A", action: "archive" });
  assert.equal(identity, "mailroom:AAMk-A:archive");
});

test("command identity is never keyed on conversation alone", () => {
  const identity = mailroomCommandIdentity({ internetMessageId: "<a@b.com>", outlookMessageId: "X", action: "archive" });
  assert.match(identity, /<a@b\.com>/);
});
