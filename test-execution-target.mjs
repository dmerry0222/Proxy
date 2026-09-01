import test from "node:test";
import assert from "node:assert/strict";
import { resolveExecutionTarget } from "./src/lib/mailroom/executionTarget.ts";

test("picks the newest live Inbox message as the target, not a stale analysis id", () => {
  // This is the exact production shape that produced ErrorItemNotFound:
  // mailroom_conversations.latest_message_id points at "stale-id", which is
  // no longer a live Inbox message; a newer message has since arrived.
  const rows = [
    { outlook_message_id: "stale-id", internet_message_id: "<stale@x>", is_in_inbox: false, message_at: "2026-08-20T10:00:00Z", received_at: null },
    { outlook_message_id: "old-inbox-id", internet_message_id: "<old@x>", is_in_inbox: true, message_at: "2026-08-25T10:00:00Z", received_at: null },
    { outlook_message_id: "current-live-id", internet_message_id: "<current@x>", is_in_inbox: true, message_at: "2026-08-30T10:00:00Z", received_at: null },
  ];

  const target = resolveExecutionTarget(rows, "stale-id");

  assert.equal(target.outlookMessageId, "current-live-id");
  assert.equal(target.internetMessageId, "<current@x>");
  assert.deepEqual(target.priorInboxMessageIds, ["old-inbox-id"]);
  assert.equal(target.stale, true);
});

test("matches latest_message_id when it is still the live current Inbox message", () => {
  const rows = [
    { outlook_message_id: "old-inbox-id", internet_message_id: "<old@x>", is_in_inbox: true, message_at: "2026-08-25T10:00:00Z", received_at: null },
    { outlook_message_id: "current-live-id", internet_message_id: "<current@x>", is_in_inbox: true, message_at: "2026-08-30T10:00:00Z", received_at: null },
  ];

  const target = resolveExecutionTarget(rows, "current-live-id");

  assert.equal(target.outlookMessageId, "current-live-id");
  assert.equal(target.stale, false);
});

test("falls back to received_at when message_at is missing", () => {
  const rows = [
    { outlook_message_id: "a", internet_message_id: null, is_in_inbox: true, message_at: null, received_at: "2026-08-20T10:00:00Z" },
    { outlook_message_id: "b", internet_message_id: null, is_in_inbox: true, message_at: null, received_at: "2026-08-29T10:00:00Z" },
  ];

  const target = resolveExecutionTarget(rows, "a");

  assert.equal(target.outlookMessageId, "b");
  assert.deepEqual(target.priorInboxMessageIds, ["a"]);
});

test("ignores non-inbox rows entirely when selecting the current message", () => {
  const rows = [
    { outlook_message_id: "archived-newer", internet_message_id: null, is_in_inbox: false, message_at: "2026-08-31T10:00:00Z", received_at: null },
    { outlook_message_id: "inbox-older", internet_message_id: null, is_in_inbox: true, message_at: "2026-08-20T10:00:00Z", received_at: null },
  ];

  const target = resolveExecutionTarget(rows, "inbox-older");

  assert.equal(target.outlookMessageId, "inbox-older");
  assert.deepEqual(target.priorInboxMessageIds, []);
});

test("returns null when no live Inbox message remains -- caller decides idempotent vs. failure", () => {
  const rows = [
    { outlook_message_id: "archived-1", internet_message_id: null, is_in_inbox: false, message_at: "2026-08-20T10:00:00Z", received_at: null },
  ];

  assert.equal(resolveExecutionTarget(rows, "archived-1"), null);
  assert.equal(resolveExecutionTarget([], "anything"), null);
});
