import test from "node:test";
import assert from "node:assert/strict";
import {
  activeReviewCard,
  selectActiveReviewQueue,
  withResolved,
} from "./src/lib/memory/reviewQueue.ts";

const ROI = { id: "roi", title: "Emphasized ROI of degrees messaging" };
const NEXT = { id: "next", title: "Next pending item" };
const THIRD = { id: "third", title: "Third pending item" };
const QUEUE = [ROI, NEXT, THIRD];

const NONE = new Set();

test("the first server item is the active card", () => {
  assert.equal(activeReviewCard(QUEUE, NONE), ROI);
  assert.equal(selectActiveReviewQueue(QUEUE, NONE).length, 3);
});

test("resolving the current card removes it and promotes the next one immediately", () => {
  const resolved = withResolved(NONE, ROI.id);

  assert.equal(activeReviewCard(QUEUE, resolved), NEXT);
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 2);
});

test("the visible count decrements by exactly one per resolution", () => {
  let resolved = NONE;
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 3);

  resolved = withResolved(resolved, ROI.id);
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 2);

  resolved = withResolved(resolved, NEXT.id);
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 1);
});

test("a STALE server response cannot resurrect a resolved card (the actual bug)", () => {
  // Reproduces what a statically-cached /memory/review served: a server
  // payload that still lists an item the user already resolved. Before the
  // fix this reappeared as the active card, and the RPC then refused it
  // with "already resolved or dismissed", stranding the queue.
  const resolved = withResolved(NONE, ROI.id);
  const staleServerPayload = [ROI, NEXT, THIRD];

  assert.notEqual(activeReviewCard(staleServerPayload, resolved), ROI);
  assert.equal(activeReviewCard(staleServerPayload, resolved), NEXT);
  assert.equal(
    selectActiveReviewQueue(staleServerPayload, resolved).some((item) => item.id === ROI.id),
    false,
  );
});

test("a refresh racing the write cannot re-show the card either", () => {
  // The refresh lands before the DB write is visible, so the server still
  // reports every item as pending. The resolved set outlives the fetch.
  const resolved = withResolved(withResolved(NONE, ROI.id), NEXT.id);
  assert.equal(activeReviewCard(QUEUE, resolved), THIRD);
});

test("a fresh server response that already dropped the item stays consistent", () => {
  const resolved = withResolved(NONE, ROI.id);
  const freshPayload = [NEXT, THIRD];

  assert.equal(activeReviewCard(freshPayload, resolved), NEXT);
  assert.equal(selectActiveReviewQueue(freshPayload, resolved).length, 2);
});

test("resolving every item empties the queue and shows no active card", () => {
  let resolved = NONE;
  for (const item of QUEUE) resolved = withResolved(resolved, item.id);

  assert.equal(activeReviewCard(QUEUE, resolved), null);
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 0);
});

test("newly arrived server items still appear after earlier resolutions", () => {
  const resolved = withResolved(NONE, ROI.id);
  const withNewItem = [ROI, NEXT, THIRD, { id: "new", title: "Newly extracted" }];

  assert.equal(selectActiveReviewQueue(withNewItem, resolved).length, 3);
  assert.equal(activeReviewCard(withNewItem, resolved), NEXT);
});

test("withResolved never mutates the set it is given", () => {
  // React must see a new reference, and the old set must stay intact.
  const original = new Set(["a"]);
  const next = withResolved(original, "b");

  assert.equal(original.has("b"), false);
  assert.equal(next.has("a"), true);
  assert.equal(next.has("b"), true);
  assert.notEqual(original, next);
});

test("resolving an id that is not in the queue is harmless", () => {
  const resolved = withResolved(NONE, "not-in-queue");
  assert.equal(selectActiveReviewQueue(QUEUE, resolved).length, 3);
});
