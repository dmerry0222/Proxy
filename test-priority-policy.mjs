import test from "node:test";
import assert from "node:assert/strict";
import { computeItemSignals, isEligibleForExecutionDirective } from "./src/lib/cos/computeSignals.ts";
import { deterministicDirectiveFallback, detectOverload, needsReassessment } from "./src/lib/cos/priorityPolicy.ts";
import { isManualOverrideActive, isDirectiveStale, validatePriorityDirective } from "./src/lib/cos/priorityDirective.ts";

const now = new Date("2026-08-29T00:00:00Z");

function baseItem(overrides = {}) {
  return {
    id: "item-1",
    title: "Test item",
    status: "active",
    responsibility: "mine",
    confirmedByUser: true,
    timingAt: null,
    timingKind: null,
    deferredUntil: null,
    waitingSince: null,
    expectedAt: null,
    projectStateId: null,
    currentDirective: null,
    pendingAttentionCount: 0,
    ...overrides,
  };
}

test("candidate items are never eligible for an execution directive", () => {
  const signals = computeItemSignals(baseItem({ status: "candidate", confirmedByUser: false }), null, now);
  assert.equal(isEligibleForExecutionDirective(signals), false);
});

test("unconfirmed active items are not eligible (must be explicitly accepted)", () => {
  const signals = computeItemSignals(baseItem({ confirmedByUser: false }), null, now);
  assert.equal(isEligibleForExecutionDirective(signals), false);
});

test("external items are never eligible for an execution directive", () => {
  const signals = computeItemSignals(baseItem({ responsibility: "external" }), null, now);
  assert.equal(isEligibleForExecutionDirective(signals), false);
});

test("confirmed active Dave-owned items are eligible", () => {
  const signals = computeItemSignals(baseItem(), null, now);
  assert.equal(isEligibleForExecutionDirective(signals), true);
});

test("hard deadline alone does not force P1 in the deterministic fallback", () => {
  const item = baseItem({ timingAt: "2026-09-01T00:00:00Z", timingKind: "must" });
  const signals = computeItemSignals(item, null, now);
  const directive = deterministicDirectiveFallback(signals, item.timingAt, item.timingKind, now);
  assert.notEqual(directive.tier, "P1");
});

test("overdue hard deadline does escalate to P1 with protected execution time", () => {
  const item = baseItem({ timingAt: "2026-08-20T00:00:00Z", timingKind: "must" });
  const signals = computeItemSignals(item, null, now);
  const directive = deterministicDirectiveFallback(signals, item.timingAt, item.timingKind, now);
  assert.equal(directive.tier, "P1");
  assert.equal(directive.protection, "protected");
});

test("strategically important undated work can still reach P2 via project association", () => {
  const item = baseItem({ projectStateId: "proj-1" });
  const signals = computeItemSignals(item, { id: "proj-1", status: "active", currentDirective: { tier: "P1", why: "Launch" } }, now);
  const directive = deterministicDirectiveFallback(signals, null, null, now);
  assert.equal(directive.tier, "P2");
  assert.match(directive.why, /Launch/);
});

test("validator rejects an invalid tier from model output", () => {
  const result = validatePriorityDirective(
    { tier: "P0", why: "x", hardness: "soft", protection: "normal", mayDisplace: [], source: "cos", decidedAt: now.toISOString() },
    null
  );
  assert.equal(result.ok, false);
});

test("validator rejects a directive whose timing does not match the item's canonical timing", () => {
  const result = validatePriorityDirective(
    {
      tier: "P2", why: "x", hardness: "hard", protection: "normal", mayDisplace: [], source: "cos", decidedAt: now.toISOString(),
      timing: { kind: "must", at: "2026-12-25T00:00:00Z" },
    },
    { timingAt: "2026-09-01T00:00:00Z", timingKind: "must" }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match/);
});

test("validator rejects invented timing on an item with none", () => {
  const result = validatePriorityDirective(
    { tier: "P2", why: "x", hardness: "hard", protection: "normal", mayDisplace: [], source: "cos", decidedAt: now.toISOString(), timing: { kind: "must", at: "2026-12-25T00:00:00Z" } },
    { timingAt: null, timingKind: null }
  );
  assert.equal(result.ok, false);
});

test("a manual override with no reassessAt stays active indefinitely", () => {
  const directive = { tier: "P1", why: "x", hardness: "hard", protection: "protected", mayDisplace: [], source: "manual", decidedAt: now.toISOString() };
  assert.equal(isManualOverrideActive(directive, now), true);
});

test("a manual override expires once its reassessAt has passed", () => {
  const directive = { tier: "P1", why: "x", hardness: "hard", protection: "protected", mayDisplace: [], source: "manual", decidedAt: "2026-08-01T00:00:00Z", reassessAt: "2026-08-15T00:00:00Z" };
  assert.equal(isManualOverrideActive(directive, now), false);
});

test("a cos directive is stale once past its reassessAt", () => {
  const directive = { tier: "P2", why: "x", hardness: "moderate", protection: "normal", mayDisplace: [], source: "cos", decidedAt: "2026-08-01T00:00:00Z", reassessAt: "2026-08-15T00:00:00Z" };
  assert.equal(isDirectiveStale(directive, now), true);
});

test("needsReassessment never reassesses an active manual override", () => {
  const item = baseItem({ currentDirective: { tier: "P1", source: "manual", decidedAt: now.toISOString() } });
  const signals = computeItemSignals(item, null, now);
  assert.equal(needsReassessment(signals).needed, false);
});

test("needsReassessment triggers when an item became overdue since its last directive", () => {
  const item = baseItem({
    timingAt: "2026-08-20T00:00:00Z", timingKind: "must",
    currentDirective: { tier: "P3", source: "cos", decidedAt: "2026-08-10T00:00:00Z" },
  });
  const signals = computeItemSignals(item, null, now);
  assert.equal(needsReassessment(signals).needed, true);
});

test("too many simultaneously protected P1 items is flagged as overload", () => {
  const directives = Array.from({ length: 6 }, () => ({ tier: "P1", protection: "protected" }));
  const result = detectOverload(directives, 5);
  assert.equal(result.overloaded, true);
});

test("five or fewer protected P1 items is not overload", () => {
  const directives = Array.from({ length: 5 }, () => ({ tier: "P1", protection: "protected" }));
  const result = detectOverload(directives, 5);
  assert.equal(result.overloaded, false);
});
