import test from "node:test";
import assert from "node:assert/strict";
import { classifyClaimRelationshipDeterministically as classify } from "./src/lib/memory/claimReconciliationRules.ts";
import { classifyCorrectionFeedbackLocally } from "./src/lib/memory/correctionFeedbackRules.ts";

const existing = (statement, confirmed_by_user = false) => ({
  id: "claim-1", statement, status: confirmed_by_user ? "durable" : "candidate",
  confirmed_by_user, evidence_strength: confirmed_by_user ? "confirmed" : "moderate",
});
const rubric = "Heather is leading development of the Graduate Program Portfolio Health Rubric for Suffolk University.";

test("same extraction is an exact duplicate", () => {
  assert.equal(classify(rubric, existing(rubric)), "duplicates_existing");
});
test("same proposition from a newer extraction supports the existing claim", () => {
  assert.equal(classify("Heather leads development of the Graduate Program Portfolio Health Rubric for Suffolk University.", existing(rubric, true)), "supports_existing");
});
test("different-source equivalent wording supports an existing claim", () => {
  assert.equal(classify("Heather is working on the Graduate Program Portfolio Health Rubric.", existing(rubric, true)), "supports_existing");
});
test("temporary meeting detail does not reopen a confirmed proposition", () => {
  assert.equal(classify("Heather leads development of the Graduate Program Portfolio Health Rubric for Monday's Grad Strategy meeting.", existing(rubric, true)), "supports_existing");
});
test("confirmed durable claim suppresses equivalent review candidates", () => {
  assert.equal(classify("Heather owns the Graduate Program Portfolio Health Rubric for Suffolk University.", existing(rubric, true)), "supports_existing");
});
test("credible negation contradicts an existing claim", () => {
  assert.equal(classify("Heather is not leading development of the Graduate Program Portfolio Health Rubric for Suffolk University.", existing(rubric, true)), "contradicts_existing");
});
test("real-world change is treated as supersession", () => {
  assert.equal(classify("Heather no longer leads development of the Graduate Program Portfolio Health Rubric for Suffolk University.", existing(rubric, true)), "supersedes_existing");
});
test("retention feedback is dismissal rather than a fact", () => {
  assert.equal(classifyCorrectionFeedbackLocally("unnecessary to remember this"), "dismissal");
  assert.equal(classifyCorrectionFeedbackLocally("don't remember this"), "dismissal");
});
test("an actual factual correction is left for semantic classification", () => {
  assert.equal(classifyCorrectionFeedbackLocally("Heather now leads undergraduate strategy, not graduate strategy."), null);
});
test("many Heather emails converge on one governing proposition", () => {
  const observations = [
    rubric,
    "Heather leads development of the Graduate Program Portfolio Health Rubric for Suffolk University.",
    "Heather is working on the Graduate Program Portfolio Health Rubric.",
  ];
  assert.deepEqual(observations.map((value) => classify(value, existing(rubric, true))),
    ["duplicates_existing", "supports_existing", "supports_existing"]);
});

