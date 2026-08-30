import test from "node:test";
import assert from "node:assert/strict";
import { titleSimilarity } from "./src/lib/reconciliation/titleSimilarity.ts";

test("identical titles score 1.0", () => {
  assert.equal(titleSimilarity("Send revised requirements to committee", "Send revised requirements to committee"), 1);
});
test("same obligation, reworded, scores high (clearly same obligation)", () => {
  const score = titleSimilarity(
    "Send the revised requirements packet to the committee",
    "Send revised requirements packet to committee"
  );
  assert.ok(score >= 0.6, `expected >= 0.6, got ${score}`);
});
test("related-but-distinct deliverable (the observed Phase 3/4 anecdote) no longer scores above the attach threshold", () => {
  const score = titleSimilarity(
    "Draft Phase 3 diagnostic onboarding checklist for committee",
    "Draft Phase 3 diagnostic onboarding slide deck for new-hire orientation session"
  );
  assert.ok(score < 0.6, `expected < 0.6 (old min-denominator formula scored this 0.67), got ${score}`);
});
test("same title but a genuinely unrelated short candidate does not inflate via the min-denominator effect", () => {
  const score = titleSimilarity("Update the Phase 4 status report", "Phase 4 kickoff");
  assert.ok(score < 0.35, `expected a low score for a short, mostly-different title, got ${score}`);
});
test("completely unrelated titles score at or near 0", () => {
  const score = titleSimilarity("Send security requirements to Aki", "Book the conference room for Friday");
  assert.ok(score < 0.2, `expected near 0, got ${score}`);
});
test("empty/whitespace-only titles never divide by zero", () => {
  assert.equal(titleSimilarity("", "Send requirements"), 0);
  assert.equal(titleSimilarity("   ", "Send requirements"), 0);
});
