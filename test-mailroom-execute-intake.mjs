import test from "node:test";
import assert from "node:assert/strict";
import {
  isHumanConfirmed,
  latestPerConversation,
  planIntake,
  planIntakeBatch,
  qualifiesForExecute,
} from "./src/lib/execute/mailroomIntakePolicy.ts";

function row(overrides = {}) {
  return {
    id: "row-1",
    conversationId: "conv-1",
    requestedAction: "needs_attention",
    recommendedAction: "needs_attention",
    selectedActionSource: "default",
    reviewState: "pending",
    category: "needs_you",
    summary: "Kerrie needs the assessment flow before the faculty session.",
    latestMessageId: "msg-1",
    receivedAt: "2026-08-30T10:00:00Z",
    createdAt: "2026-08-30T11:00:00Z",
    subject: "Assessment flow for the faculty pilot",
    senderName: "Kerrie",
    ...overrides,
  };
}

test("only Needs Attention becomes Execute work", () => {
  assert.equal(qualifiesForExecute(row()), true);
  for (const action of ["archive", "draft_reply", "accept_invite", "none", null]) {
    assert.equal(qualifiesForExecute(row({ requestedAction: action })), false);
  }
});

test("the newest analysis of a conversation wins, not the first", () => {
  // mailroom_conversations holds one row per RUN: 1055 rows across ~141
  // Needs Attention conversations today. Without this collapse, an old run's
  // classification could outvote the current one.
  const rows = [
    row({ id: "old", createdAt: "2026-08-01T00:00:00Z", requestedAction: "archive" }),
    row({ id: "new", createdAt: "2026-08-30T00:00:00Z", requestedAction: "needs_attention" }),
    row({ id: "middle", createdAt: "2026-08-15T00:00:00Z", requestedAction: "archive" }),
  ];

  const latest = latestPerConversation(rows);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, "new");
});

test("a human decision outranks a default classification", () => {
  assert.equal(isHumanConfirmed(row()), false);
  assert.equal(isHumanConfirmed(row({ selectedActionSource: "notion" })), true);
  assert.equal(isHumanConfirmed(row({ selectedActionSource: "proxy_ui" })), true);
  assert.equal(isHumanConfirmed(row({ reviewState: "submitted" })), true);

  assert.equal(planIntake(row()).status, "candidate");
  assert.equal(planIntake(row({ selectedActionSource: "notion" })).status, "active");
  assert.equal(planIntake(row({ selectedActionSource: "notion" })).confirmedByUser, true);
});

test("the subject becomes the title and the summary becomes the body", () => {
  const plan = planIntake(row());
  assert.equal(plan.title, "Assessment flow for the faculty pilot");
  assert.equal(plan.description, "Kerrie needs the assessment flow before the faculty session.");
  assert.match(plan.whySurfaced, /Proxy classified it Needs Attention \(from Kerrie\)/);
});

test("a conversation with no subject still gets a readable title", () => {
  const plan = planIntake(row({ subject: null }));
  assert.equal(plan.title, "Kerrie needs the assessment flow before the faculty session.");

  const bare = planIntake(row({ subject: null, summary: null }));
  assert.match(bare.title, /^Needs attention: conversation /);
});

test("the plan carries the source date so curation ages it from the email, not the import", () => {
  const plan = planIntake(row());
  assert.equal(plan.metadata.source_occurred_at, "2026-08-30T10:00:00Z");
  assert.equal(plan.metadata.conversation_id, "conv-1");
});

test("reprocessing creates nothing new -- the whole idempotency claim", () => {
  const rows = [row(), row({ id: "row-2", createdAt: "2026-08-31T00:00:00Z" })];

  const first = planIntakeBatch(rows, []);
  assert.equal(first.toCreate.length, 1);
  assert.equal(first.toRefresh.length, 0);

  const second = planIntakeBatch(rows, [{ conversationId: "conv-1", withdrawn: false }]);
  assert.equal(second.toCreate.length, 0);
  assert.equal(second.toRefresh.length, 1);
  assert.deepEqual(second.toWithdraw, []);
});

test("an email that stops qualifying is withdrawn, never deleted", () => {
  const diff = planIntakeBatch(
    [row({ requestedAction: "archive" })],
    [{ conversationId: "conv-1", withdrawn: false }]
  );

  assert.deepEqual(diff.toWithdraw, ["conv-1"]);
  assert.equal(diff.toCreate.length, 0);
  assert.equal(diff.toRefresh.length, 0);
});

test("an already-withdrawn item is not withdrawn twice", () => {
  const diff = planIntakeBatch(
    [row({ requestedAction: "archive" })],
    [{ conversationId: "conv-1", withdrawn: true }]
  );
  assert.deepEqual(diff.toWithdraw, []);
});

test("a conversation that qualifies again is reinstated rather than duplicated", () => {
  const diff = planIntakeBatch(
    [row()],
    [{ conversationId: "conv-1", withdrawn: true }]
  );

  assert.deepEqual(diff.toReinstate, ["conv-1"]);
  assert.equal(diff.toCreate.length, 0);
  assert.equal(diff.toRefresh.length, 1);
});

test("many runs of the same conversation still produce exactly one item", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    row({ id: `run-${index}`, createdAt: `2026-08-${String(10 + index).padStart(2, "0")}T00:00:00Z` })
  );

  const diff = planIntakeBatch(rows, []);
  assert.equal(diff.toCreate.length, 1);
  assert.equal(diff.toCreate[0].conversationId, "conv-1");
});
