import test from "node:test";
import assert from "node:assert/strict";
import {
  DUE_HORIZON_DAYS,
  UNCONFIRMED_GRACE_DAYS,
  assessCuration,
} from "./src/lib/execute/curationPolicy.ts";

const NOW = new Date("2026-09-01T12:00:00Z");

function daysFromNow(days) {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

function item(overrides = {}) {
  return {
    status: "candidate",
    responsibility: "mine",
    priorityTier: null,
    confirmedByUser: false,
    timingAt: null,
    timingKind: null,
    plannedAt: null,
    deferredUntil: null,
    expectedAt: null,
    waitingOnName: null,
    sourceSystem: "mailroom",
    sourceWithdrawnAt: null,
    projectStateId: null,
    createdAt: daysFromNow(-1),
    now: NOW,
    ...overrides,
  };
}

test("every outcome states a reason, in exactly one direction", () => {
  for (const candidate of [
    item(),
    item({ status: "completed" }),
    item({ responsibility: "external" }),
    item({ priorityTier: "background" }),
    item({ createdAt: daysFromNow(-400) }),
  ]) {
    const result = assessCuration(candidate);
    if (result.curated) {
      assert.ok(result.whySurfaced, "a curated item must say why it surfaced");
      assert.equal(result.whySuppressed, null);
    } else {
      assert.ok(result.whySuppressed, "a suppressed item must say why it was held back");
      assert.equal(result.whySurfaced, null);
    }
  }
});

test("completed and cancelled work leaves the curated view but keeps a reason", () => {
  for (const status of ["completed", "cancelled"]) {
    const result = assessCuration(item({ status }));
    assert.equal(result.curated, false);
    assert.match(result.whySuppressed, new RegExp(status));
  }
});

test("a deferred item is suppressed until its date, then returns", () => {
  const stillDeferred = assessCuration(item({ deferredUntil: daysFromNow(3) }));
  assert.equal(stillDeferred.curated, false);
  assert.match(stillDeferred.whySuppressed, /Deferred until/);

  const elapsed = assessCuration(item({ deferredUntil: daysFromNow(-3) }));
  assert.equal(elapsed.curated, true);
});

test("a due date inside the horizon surfaces the item; one beyond it does not", () => {
  const soon = assessCuration(item({ timingAt: daysFromNow(DUE_HORIZON_DAYS - 1), timingKind: "must" }));
  assert.equal(soon.curated, true);
  assert.match(soon.whySurfaced, /^Due /);

  const distant = assessCuration(item({ timingAt: daysFromNow(DUE_HORIZON_DAYS + 30), createdAt: daysFromNow(-400) }));
  assert.equal(distant.curated, false);
});

test("overdue work always surfaces", () => {
  const result = assessCuration(item({ timingAt: daysFromNow(-2), timingKind: "must", createdAt: daysFromNow(-400) }));
  assert.equal(result.curated, true);
  assert.match(result.whySurfaced, /Overdue/);
});

test("external work waits quietly until it is late, then becomes Dave's problem", () => {
  const waiting = assessCuration(
    item({ responsibility: "external", expectedAt: daysFromNow(5), waitingOnName: "Aki" })
  );
  assert.equal(waiting.curated, false);
  assert.match(waiting.whySuppressed, /Waiting on Aki/);

  const overdue = assessCuration(
    item({ responsibility: "external", expectedAt: daysFromNow(-5), waitingOnName: "Aki" })
  );
  assert.equal(overdue.curated, true);
  assert.match(overdue.whySurfaced, /Overdue: expected from Aki/);
});

test("a background tier from the Chief of Staff suppresses; P1/P2 surfaces", () => {
  assert.equal(assessCuration(item({ priorityTier: "background" })).curated, false);

  for (const tier of ["P1", "P2"]) {
    const result = assessCuration(item({ priorityTier: tier, createdAt: daysFromNow(-400) }));
    assert.equal(result.curated, true);
    assert.match(result.whySurfaced, new RegExp(tier));
  }
});

test("a manual planning date keeps an old item on the curated surface", () => {
  const result = assessCuration(item({ createdAt: daysFromNow(-400), plannedAt: daysFromNow(2) }));
  assert.equal(result.curated, true);
  assert.match(result.whySurfaced, /You planned this/);
});

test("an old unconfirmed candidate with nothing attached is suppressed, legibly", () => {
  // The 166 candidate items that exist today: no directive, no date, no
  // project, never confirmed. They stay fully visible in the audit view.
  const result = assessCuration(item({ createdAt: daysFromNow(-90), sourceSystem: "artifact" }));
  assert.equal(result.curated, false);
  assert.match(result.whySuppressed, /Unconfirmed artifact candidate/);
  assert.match(result.whySuppressed, /never confirmed/);
});

test("the grace period is measured from when the SOURCE happened, not from import", () => {
  // A year of mail backfilled today must not all look brand new.
  const backfilled = assessCuration(
    item({ createdAt: NOW.toISOString(), sourceOccurredAt: daysFromNow(-200) })
  );
  assert.equal(backfilled.curated, false);

  const genuinelyRecent = assessCuration(
    item({ createdAt: NOW.toISOString(), sourceOccurredAt: daysFromNow(-(UNCONFIRMED_GRACE_DAYS - 1)) })
  );
  assert.equal(genuinelyRecent.curated, true);
});

test("attaching a project keeps a candidate curated indefinitely", () => {
  const result = assessCuration(item({ createdAt: daysFromNow(-400), projectStateId: "project-1" }));
  assert.equal(result.curated, true);
  assert.match(result.whySurfaced, /Attached to a project/);
});

test("a withdrawn source is suppressed as history -- unless Dave already took it up", () => {
  const withdrawn = assessCuration(item({ sourceWithdrawnAt: daysFromNow(-1) }));
  assert.equal(withdrawn.curated, false);
  assert.match(withdrawn.whySuppressed, /kept as history rather than deleted/);

  const daveOwnsItNow = assessCuration(
    item({ sourceWithdrawnAt: daysFromNow(-1), status: "active", confirmedByUser: true })
  );
  assert.equal(daveOwnsItNow.curated, true);
});
