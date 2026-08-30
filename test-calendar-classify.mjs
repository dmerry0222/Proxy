import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "./src/lib/reconciliation/calendarClassify.ts";

test("explicit deliverable in description clears the shared ownership gate", () => {
  const result = classify(
    { kind: "dave_owned", actionTitle: "Present final proposal", ownershipBasis: "explicit_assignment_to_dave", excerpt: "Dave to present final proposal." },
    "2026-09-01T14:00:00Z"
  );
  assert.equal(result.kind, "dave_owned");
  assert.equal(result.envelope.ownership.owner, "dave");
});
test("attendee/organizer role alone never populates an actor (Part 11)", () => {
  const result = classify(
    { kind: "dave_owned", ownershipBasis: "explicit_assignment_to_dave", excerpt: "Dave to present final proposal." },
    null
  );
  assert.equal(result.kind, "dave_owned");
  assert.deepEqual(result.envelope.actors, [], "calendar dave_owned envelopes must never carry an actor derived from attendee/organizer role");
});
test("missing ownership basis does not clear the gate (event existing/attending is not evidence)", () => {
  const result = classify({ kind: "dave_owned", excerpt: "Dave attended the meeting." }, null);
  assert.equal(result.kind, "none");
});
test("missing excerpt does not clear the gate even with a valid basis", () => {
  const result = classify({ kind: "dave_owned", ownershipBasis: "explicit_assignment_to_dave" }, null);
  assert.equal(result.kind, "none");
});
test("unrecognized ownership basis (untrusted model output) does not clear the gate", () => {
  const result = classify({ kind: "dave_owned", ownershipBasis: "dave_was_organizer", excerpt: "Dave organized this." }, null);
  assert.equal(result.kind, "none");
});
test("prep_context with a concrete summary is recorded", () => {
  const result = classify({ kind: "prep_context", summary: "Bring the Q3 budget numbers", contextType: "reminder_context" }, null);
  assert.equal(result.kind, "prep_context");
  assert.equal(result.summary, "Bring the Q3 budget numbers");
  assert.equal(result.contextType, "reminder_context");
});
test("prep_context falls back to 'other' for an invalid contextType rather than dropping it", () => {
  const result = classify({ kind: "prep_context", summary: "Bring the Q3 budget numbers", contextType: "not_a_real_type" }, null);
  assert.equal(result.kind, "prep_context");
  assert.equal(result.contextType, "other");
});
test("prep_context with no summary is not recorded", () => {
  const result = classify({ kind: "prep_context", contextType: "reminder_context" }, null);
  assert.equal(result.kind, "none");
});
test("completion is never a possible calendar outcome (Part E: a past occurrence alone is not completion evidence)", () => {
  const result = classify({ kind: "completion", excerpt: "The meeting happened." }, null);
  assert.equal(result.kind, "none");
});
test("unknown kind is never recorded", () => {
  const result = classify({ kind: "something_else" }, null);
  assert.equal(result.kind, "none");
});
