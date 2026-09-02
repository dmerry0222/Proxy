import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_REVIEW_OPTIONS,
  PENDING_CONTEXT_REVIEW_OPTIONS,
  reviewOptionsFor,
} from "./src/lib/memory/reviewOptions.ts";

test("an artifact-ingestion pending_context payload still yields answer buttons (the actual bug)", () => {
  // The exact payload artifact ingestion wrote: no options key at all, so
  // the card rendered its question above an empty box, and pending_context
  // has no "Actually…" fallback to resolve it with.
  const options = reviewOptionsFor("pending_context", undefined);

  assert.deepEqual(options, [...PENDING_CONTEXT_REVIEW_OPTIONS]);
  assert.ok(options.length > 0);
});

test("pending_context options the writer supplied are left alone", () => {
  const supplied = ["Follow up", "Keep waiting", "Resolved", "Dismiss"];
  assert.deepEqual(reviewOptionsFor("pending_context", supplied), supplied);
});

test("a pending_context payload of empty/blank strings is treated as missing", () => {
  assert.deepEqual(
    reviewOptionsFor("pending_context", ["", "   "]),
    [...PENDING_CONTEXT_REVIEW_OPTIONS],
  );
});

test("every default pending_context option maps to an action the RPC accepts", () => {
  // resolve_memory_pending_review_item only accepts these four.
  const accepted = new Set(["follow_up", "keep_waiting", "resolved", "dismiss"]);
  const toAction = (option) => option.trim().toLowerCase().replace(/ /g, "_");

  for (const option of PENDING_CONTEXT_REVIEW_OPTIONS) {
    assert.ok(accepted.has(toAction(option)), `${option} is not an accepted action`);
  }
});

test("confirm_claim rows predating Dismiss still get it appended", () => {
  const legacy = ["Confirm", "Outdated", "Keep as evidence", "Not sure"];
  assert.deepEqual(reviewOptionsFor("confirm_claim", legacy), [...legacy, "Dismiss"]);
});

test("confirm_claim keeps a single Dismiss, whatever its casing", () => {
  const options = reviewOptionsFor("confirm_claim", ["Confirm", "dismiss"]);
  assert.equal(options.filter((option) => option.toLowerCase() === "dismiss").length, 1);
});

test("a confirm_claim row with no options falls back to the full claim set", () => {
  assert.deepEqual(reviewOptionsFor("confirm_claim", []), [...CLAIM_REVIEW_OPTIONS]);
});

test("an unknown review type is passed through untouched", () => {
  assert.deepEqual(reviewOptionsFor("something_new", ["Yes", "No"]), ["Yes", "No"]);
  assert.deepEqual(reviewOptionsFor("something_new", null), []);
});
