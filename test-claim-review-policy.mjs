import test from "node:test";
import assert from "node:assert/strict";
import { assessClaimReviewTier } from "./src/lib/memory/claimReviewPolicy.ts";

function baseInput(overrides = {}) {
  return {
    claimType: "preference",
    statement: "Usually responds by email rather than phone.",
    evidenceStrength: "moderate",
    relationship: "new",
    existingClaim: null,
    ...overrides,
  };
}

test("low-stakes communication preference auto-saves", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "preference",
    statement: "Sarah usually responds by email rather than phone.",
  }));
  assert.equal(result.tier, "auto_save");
});

test("minor working observation (working_context) auto-saves", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "working_context",
    statement: "Often works with the graduate advising team on orientation.",
  }));
  assert.equal(result.tier, "auto_save");
});

test("project association auto-saves with moderate evidence", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "project_association",
    statement: "Involved in the fall orientation planning project.",
  }));
  assert.equal(result.tier, "auto_save");
});

test("role claim always requires review even with strong evidence", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "role",
    statement: "Now leads the career services team.",
    evidenceStrength: "strong",
  }));
  assert.equal(result.tier, "review");
});

test("responsibility claim always requires review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "responsibility",
    statement: "Now owns the budget approval process.",
    evidenceStrength: "confirmed",
  }));
  assert.equal(result.tier, "review");
});

test("governing_context always requires review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "governing_context",
    statement: "All career services hiring must go through Dave.",
    evidenceStrength: "confirmed",
  }));
  assert.equal(result.tier, "review");
});

test("major role/reporting claim with weak evidence still goes to review (double reason, but review either way)", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "role",
    statement: "May now report to a different director.",
    evidenceStrength: "weak",
  }));
  assert.equal(result.tier, "review");
});

test("sensitive/high-impact claim (health) remains conservative even if claim_type is low-risk-shaped", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "status",
    statement: "Is currently out on medical leave for a health issue.",
    evidenceStrength: "strong",
  }));
  assert.equal(result.tier, "review");
});

test("sensitive compensation claim requires review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "fact",
    statement: "Received a salary increase this year.",
    evidenceStrength: "confirmed",
  }));
  assert.equal(result.tier, "review");
});

test("weak evidence never auto-saves, even for a low-risk claim type", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "preference",
    statement: "Might prefer async updates over meetings.",
    evidenceStrength: "weak",
  }));
  assert.equal(result.tier, "review");
});

test("ambiguous claim types (fact, decision, relationship, other) default to review", () => {
  for (const claimType of ["fact", "decision", "relationship", "other"]) {
    const result = assessClaimReviewTier(baseInput({ claimType, statement: "Some ambiguous statement about work." }));
    assert.equal(result.tier, "review", `expected ${claimType} to default to review`);
  }
});

test("low-stakes contradiction against an unconfirmed low-risk existing claim does not require review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "working_context",
    statement: "No longer regularly works with the transfer admissions team.",
    relationship: "contradicts_existing",
    existingClaim: { claimType: "working_context", confirmedByUser: false, isGoverningContext: false },
  }));
  assert.equal(result.tier, "auto_save");
});

test("high-impact contradiction against a Dave-confirmed claim still surfaces for review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "working_context",
    statement: "No longer regularly works with the transfer admissions team.",
    relationship: "contradicts_existing",
    existingClaim: { claimType: "working_context", confirmedByUser: true, isGoverningContext: false },
  }));
  assert.equal(result.tier, "review");
});

test("contradiction against governing context always surfaces for review", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "status",
    statement: "The approval threshold has changed.",
    relationship: "contradicts_existing",
    existingClaim: { claimType: "governing_context", confirmedByUser: false, isGoverningContext: true },
  }));
  assert.equal(result.tier, "review");
});

test("supersession of a low-risk unconfirmed claim auto-saves", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "project_association",
    statement: "No longer involved in the fall orientation planning project.",
    relationship: "supersedes_existing",
    existingClaim: { claimType: "project_association", confirmedByUser: false, isGoverningContext: false },
  }));
  assert.equal(result.tier, "auto_save");
});

test("supersession of a role claim still requires review even though the new claim type is low-risk-shaped", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "status",
    statement: "Title has changed.",
    relationship: "supersedes_existing",
    existingClaim: { claimType: "role", confirmedByUser: false, isGoverningContext: false },
  }));
  assert.equal(result.tier, "review");
});

test("contradiction/supersession with no resolvable existing claim is conservative", () => {
  const result = assessClaimReviewTier(baseInput({
    claimType: "preference",
    statement: "No longer prefers email.",
    relationship: "contradicts_existing",
    existingClaim: null,
  }));
  assert.equal(result.tier, "review");
});
