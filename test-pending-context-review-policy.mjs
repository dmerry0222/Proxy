import test from "node:test";
import assert from "node:assert/strict";
import {
  assessPendingContextReviewTier,
  findDuplicatePendingContext,
} from "./src/lib/memory/pendingContextReviewPolicy.ts";

function baseInput(overrides = {}) {
  return {
    contextType: "reminder_context",
    summary: "The project kickoff moved a week later.",
    detail: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    now: new Date(),
    ...overrides,
  };
}

test("small deferred idea auto-saves", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "deferred_idea",
    summary: "Rick suggested tapping into the arts economy initiative someday.",
  }));
  assert.equal(result.outcome, "auto_save");
});

test("minor reminder_context auto-saves", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "reminder_context",
    summary: "Kickoff postponed a week to allow more prep time.",
  }));
  assert.equal(result.outcome, "auto_save");
});

test("low-stakes future_trigger auto-saves", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "future_trigger",
    summary: "Dave is scheduled to present at a reception next year.",
  }));
  assert.equal(result.outcome, "auto_save");
});

test("consequential waiting_on always requires review", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "waiting_on",
    summary: "Waiting on legal's sign-off before the contract can be sent.",
  }));
  assert.equal(result.outcome, "review_required");
});

test("important follow_up always requires review", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "follow_up",
    summary: "Follow up with the dean about the budget proposal.",
  }));
  assert.equal(result.outcome, "review_required");
});

test("commitment with an explicit deadline requires review even if the type is low-risk-shaped", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "future_trigger",
    summary: "Must confirm attendance by Friday or lose the reserved slot.",
  }));
  assert.equal(result.outcome, "review_required");
});

test("a passive-typed item with an urgent cue still surfaces for review", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "reminder_context",
    summary: "Urgent: RSVP required for the executive retreat.",
  }));
  assert.equal(result.outcome, "review_required");
});

test("ambiguous/unlisted context_type defaults to review", () => {
  const result = assessPendingContextReviewTier(baseInput({ contextType: "other", summary: "Something unclear." }));
  assert.equal(result.outcome, "review_required");
});

test("an explicitly expired item is stale regardless of type", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "deferred_idea",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }));
  assert.equal(result.outcome, "stale_or_expired");
});

test("an old low-risk item with no activity is treated as stale", () => {
  const result = assessPendingContextReviewTier(baseInput({
    contextType: "reminder_context",
    createdAt: new Date(Date.now() - 45 * 86_400_000).toISOString(),
  }));
  assert.equal(result.outcome, "stale_or_expired");
});

test("duplicate detection collapses two near-identical same-entity items created seconds apart", () => {
  const items = [
    { id: "a", entityId: "entity-1", contextType: "future_trigger", summary: "Viviana Leyva will present at SBS Faculty Learning Session on September 25, 2026 representing International Student Services.", detail: null, createdAt: "2026-08-29T22:12:40.000Z" },
    { id: "b", entityId: "entity-1", contextType: "future_trigger", summary: "Viviana committed to speak at SBS Faculty Learning Session on September 25, 2026 about International Student Services.", detail: null, createdAt: "2026-08-29T22:12:49.000Z" },
  ];
  const duplicates = findDuplicatePendingContext(items);
  assert.equal(duplicates.get("b"), "a");
  assert.equal(duplicates.has("a"), false);
});

test("duplicate detection never coalesces items about different entities, even with similar wording", () => {
  const items = [
    { id: "a", entityId: "entity-1", contextType: "waiting_on", summary: "Waiting on approval for the budget request.", detail: null, createdAt: "2026-08-29T10:00:00.000Z" },
    { id: "b", entityId: "entity-2", contextType: "waiting_on", summary: "Waiting on approval for the budget request.", detail: null, createdAt: "2026-08-29T10:00:05.000Z" },
  ];
  const duplicates = findDuplicatePendingContext(items);
  assert.equal(duplicates.size, 0);
});

test("duplicate detection does not fire for genuinely separate asks from the same entity far apart in time", () => {
  const items = [
    { id: "a", entityId: "entity-1", contextType: "waiting_on", summary: "Waiting on the signed contract from Acme.", detail: null, createdAt: "2026-08-01T10:00:00.000Z" },
    { id: "b", entityId: "entity-1", contextType: "waiting_on", summary: "Waiting on the signed contract from Acme after the second round of edits.", detail: null, createdAt: "2026-08-20T10:00:00.000Z" },
  ];
  const duplicates = findDuplicatePendingContext(items, { withinHours: 24 });
  assert.equal(duplicates.size, 0);
});

test("a high-stakes waiting_on progression (later message updates the thread) is NOT collapsed as a duplicate under the stricter bar", () => {
  const items = [
    { id: "a", entityId: "entity-1", contextType: "waiting_on", summary: "Dave is waiting for Fouad to propose a meeting time next week about database platforms.", detail: null, createdAt: "2026-08-20T10:00:00.000Z" },
    { id: "b", entityId: "entity-1", contextType: "waiting_on", summary: "Meeting with Fouad and Paul next week to discuss supported database platforms is now scheduled.", detail: null, createdAt: "2026-08-21T10:00:00.000Z" },
  ];
  const duplicates = findDuplicatePendingContext(items);
  assert.equal(duplicates.size, 0);
});

test("a near-verbatim high-stakes duplicate IS still collapsed under the stricter bar", () => {
  const items = [
    { id: "a", entityId: "entity-1", contextType: "follow_up", summary: "Dave needs to review a student placement before Friday.", detail: null, createdAt: "2026-08-20T10:00:00.000Z" },
    { id: "b", entityId: "entity-1", contextType: "follow_up", summary: "Dave needs to review a student placement before Friday.", detail: null, createdAt: "2026-08-20T10:05:00.000Z" },
  ];
  const duplicates = findDuplicatePendingContext(items);
  assert.equal(duplicates.get("b"), "a");
});
