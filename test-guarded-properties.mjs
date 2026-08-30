import test from "node:test";
import assert from "node:assert/strict";
import { resolveGuardedProperties, releaseGuardedBaseline } from "./src/lib/notion/guardedProperties.ts";

const GUARDED = ["Bucket", "Requested Action"];

// Proxy's proposal for this sync.
function props() {
  return {
    Summary: "proxy summary",
    Bucket: { type: "select", select: { name: "Needs You" } },
    "Requested Action": { type: "select", select: { name: "Needs Attention" } },
  };
}

function resolve(overrides = {}) {
  return resolveGuardedProperties({
    properties: props(),
    guarded: GUARDED,
    liveValues: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
    baseline: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
    proposedValues: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
    ...overrides,
  });
}

test("no human edit: Proxy writes both guarded properties", () => {
  const r = resolve();
  assert.deepEqual(r.overridden, []);
  assert.ok("Bucket" in r.payload && "Requested Action" in r.payload);
});

test("THE RACE: a human edit made before Submit is preserved, not reverted", () => {
  // Dave changed Bucket in Notion; Proxy still wants "Needs You".
  const r = resolve({ liveValues: { Bucket: "Low Value", "Requested Action": "Needs Attention" } });
  assert.deepEqual(r.overridden, ["Bucket"]);
  assert.equal("Bucket" in r.payload, false, "Proxy must not overwrite the human's Bucket");
});

test("an override on one property does not stop the others syncing", () => {
  const r = resolve({ liveValues: { Bucket: "Low Value", "Requested Action": "Needs Attention" } });
  assert.equal(r.payload.Summary, "proxy summary");
  assert.ok("Requested Action" in r.payload, "unedited guarded property still syncs");
});

test("both guarded properties can be overridden at once", () => {
  const r = resolve({ liveValues: { Bucket: "Low Value", "Requested Action": "Draft Reply" } });
  assert.deepEqual(r.overridden.sort(), ["Bucket", "Requested Action"]);
  assert.deepEqual(Object.keys(r.payload), ["Summary"]);
});

test("the override PERSISTS across later syncs (baseline is not re-based)", () => {
  // Re-basing to the human's value would make the next sync see agreement
  // and overwrite it -- the race, one sync later.
  const first = resolve({ liveValues: { Bucket: "Low Value", "Requested Action": "Needs Attention" } });
  assert.equal(first.nextBaseline.Bucket, "Needs You", "baseline must stay what Proxy wrote");

  const second = resolveGuardedProperties({
    properties: props(),
    guarded: GUARDED,
    liveValues: { Bucket: "Low Value", "Requested Action": "Needs Attention" },
    baseline: first.nextBaseline,
    proposedValues: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
  });
  assert.deepEqual(second.overridden, ["Bucket"], "still protected on the next sweep");
});

test("Proxy changing its own proposal does not count as a human edit", () => {
  // Reclassification: Notion still matches the last push, Proxy now wants
  // something new. That is a legitimate Proxy update, not an override.
  const r = resolveGuardedProperties({
    properties: { Bucket: { type: "select", select: { name: "Calendar" } } },
    guarded: GUARDED,
    liveValues: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
    baseline: { Bucket: "Needs You", "Requested Action": "Needs Attention" },
    proposedValues: { Bucket: "Calendar" },
  });
  assert.deepEqual(r.overridden, []);
  assert.ok("Bucket" in r.payload);
  assert.equal(r.nextBaseline.Bucket, "Calendar", "baseline follows what Proxy just wrote");
});

test("a page with no recorded baseline is treated as Proxy-owned", () => {
  // Pages created before guarding existed: with no evidence of a human
  // edit, the safe default is normal ownership, and it self-heals now.
  const r = resolve({ baseline: {} });
  assert.deepEqual(r.overridden, []);
  assert.equal(r.nextBaseline.Bucket, "Needs You");
});

test("a cleared select in Notion counts as a human edit", () => {
  const r = resolve({ liveValues: { Bucket: null, "Requested Action": "Needs Attention" } });
  assert.deepEqual(r.overridden, ["Bucket"]);
});

test("releasing the guard returns the properties to Proxy ownership", () => {
  const released = releaseGuardedBaseline({ Bucket: "Needs You", "Requested Action": "Needs Attention" }, GUARDED);
  assert.deepEqual(released, {});

  // After release, Proxy writes again even though Notion differs -- which
  // is correct: submission already made the human's value canonical.
  const r = resolve({ baseline: released, liveValues: { Bucket: "Low Value", "Requested Action": "Draft Reply" } });
  assert.deepEqual(r.overridden, []);
  assert.ok("Bucket" in r.payload);
});

test("releasing the guard leaves unrelated baseline entries alone", () => {
  const released = releaseGuardedBaseline({ Bucket: "FYI", Something: "keep me" }, GUARDED);
  assert.deepEqual(released, { Something: "keep me" });
});

test("the input properties object is never mutated", () => {
  const original = props();
  resolveGuardedProperties({
    properties: original,
    guarded: GUARDED,
    liveValues: { Bucket: "Low Value" },
    baseline: { Bucket: "Needs You" },
    proposedValues: { Bucket: "Needs You" },
  });
  assert.ok("Bucket" in original, "caller's payload must not be mutated");
});
