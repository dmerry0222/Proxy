import test from "node:test";
import assert from "node:assert/strict";
import {
  isOverdue,
  planAcceptCandidate,
  planConfirmCancellation,
  planConfirmCompletion,
  planEditItem,
  planExternalNotRelevant,
  planMarkAlreadyDone,
  planRejectCancellation,
  planRejectCandidate,
  planRejectCompletion,
  planResolveAmbiguousDifferent,
  planResolveExternal,
  planTrackWaiting,
} from "./src/lib/execute/reviewTransitions.ts";

test("accepting a Dave candidate moves it to active and confirms it", () => {
  const plan = planAcceptCandidate();
  assert.equal(plan.itemPatch?.status, "active");
  assert.equal(plan.itemPatch?.confirmed_by_user, true);
  assert.equal(plan.userOutcome, "confirmed");
});

test("rejecting as not-a-task cancels the item as an auditable outcome, never activates it", () => {
  const plan = planRejectCandidate("not_a_task");
  assert.equal(plan.itemPatch?.status, "cancelled");
  assert.notEqual(plan.itemPatch?.status, "active");
  assert.equal(plan.userOutcome, "rejected");
  assert.equal(plan.auditOutcome, "cancel");
});

test("rejecting as not-mine cancels the item, never becomes active Dave work", () => {
  const plan = planRejectCandidate("not_mine");
  assert.equal(plan.itemPatch?.status, "cancelled");
  assert.notEqual(plan.itemPatch?.status, "active");
  assert.match(plan.auditReasoning, /not his to own/);
});

test("already-done candidate goes straight to completed, not active first", () => {
  const plan = planMarkAlreadyDone();
  assert.equal(plan.itemPatch?.status, "completed");
  assert.ok(plan.itemPatch?.completed_at);
});

test("tracking external waiting work activates it without changing responsibility", () => {
  const plan = planTrackWaiting();
  assert.equal(plan.itemPatch?.status, "active");
  assert.equal("responsibility" in (plan.itemPatch ?? {}), false, "must not touch responsibility");
});

test("resolving external work marks it completed", () => {
  const plan = planResolveExternal();
  assert.equal(plan.itemPatch?.status, "completed");
});

test("external not-relevant cancels rather than silently deleting", () => {
  const plan = planExternalNotRelevant();
  assert.equal(plan.itemPatch?.status, "cancelled");
});

test("confirming a completion proposal completes the item", () => {
  const plan = planConfirmCompletion();
  assert.equal(plan.itemPatch?.status, "completed");
  assert.equal(plan.auditOutcome, "complete");
});

test("rejecting a completion proposal keeps the item open (no item mutation)", () => {
  const plan = planRejectCompletion();
  assert.equal(plan.itemPatch, null);
  assert.equal(plan.userOutcome, "rejected");
});

test("confirming a cancellation proposal cancels the item", () => {
  const plan = planConfirmCancellation();
  assert.equal(plan.itemPatch?.status, "cancelled");
  assert.equal(plan.auditOutcome, "cancel");
});

test("rejecting a cancellation proposal preserves the item (no item mutation)", () => {
  const plan = planRejectCancellation();
  assert.equal(plan.itemPatch, null);
  assert.equal(plan.userOutcome, "rejected");
});

test("ambiguous 'different item' never merges and never mutates the existing item", () => {
  const plan = planResolveAmbiguousDifferent();
  assert.equal(plan.itemPatch, null);
  assert.equal(plan.userOutcome, "rejected");
});

test("editing with no fields is a true no-op, not a hollow 'corrected' decision", () => {
  const plan = planEditItem({});
  assert.equal(plan.itemPatch, null);
  assert.equal(plan.userOutcome, null);
  assert.equal(plan.auditOutcome, null);
});

test("editing timing reuses the existing update_timing outcome", () => {
  const plan = planEditItem({ timingAt: "2026-12-01T00:00:00Z", timingKind: "must" });
  assert.equal(plan.itemPatch?.timing_at, "2026-12-01T00:00:00Z");
  assert.equal(plan.itemPatch?.timing_kind, "must");
  assert.equal(plan.auditOutcome, "update_timing");
});

test("editing project reuses the existing associate_project outcome", () => {
  const plan = planEditItem({ projectStateId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(plan.auditOutcome, "associate_project");
});

test("isOverdue is true only strictly in the past", () => {
  const now = new Date("2026-08-29T00:00:00Z");
  assert.equal(isOverdue("2026-08-28T00:00:00Z", now), true);
  assert.equal(isOverdue("2026-08-30T00:00:00Z", now), false);
  assert.equal(isOverdue(null, now), false);
});
