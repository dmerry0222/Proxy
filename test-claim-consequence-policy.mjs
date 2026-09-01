import test from "node:test";
import assert from "node:assert/strict";
import { assessClaimConsequence } from "./src/lib/memory/claimConsequencePolicy.ts";
import { assessClaimReviewTier } from "./src/lib/memory/claimReviewPolicy.ts";

function tier(overrides = {}) {
  return assessClaimReviewTier({
    claimType: "fact",
    statement: "",
    evidenceStrength: "moderate",
    relationship: "new",
    existingClaim: null,
    ...overrides,
  });
}

/* -------------------- consequence signal detection -------------------- */

test("money signals are high consequence", () => {
  for (const statement of [
    "The GrayDI contract will cost $12,000 for the year.",
    "The Career Ambassador budget was reduced to $3,000.",
    "Approved additional funding for the TILT program.",
  ]) {
    assert.equal(assessClaimConsequence(statement).level, "high", statement);
  }
});

test("contract, deadline, and compliance signals are high consequence", () => {
  assert.equal(assessClaimConsequence("The vendor contract must be signed by September 1.").level, "high");
  assert.equal(assessClaimConsequence("The proposal deadline is Friday.").level, "high");
  assert.equal(assessClaimConsequence("This falls under FERPA compliance review.").level, "high");
});

test("program viability and employment signals are high consequence", () => {
  assert.equal(assessClaimConsequence("The EMBA program may be discontinued due to low enrollment.").level, "high");
  assert.equal(assessClaimConsequence("A search committee was formed for the new position.").level, "high");
});

test("compensation paid in time off is high consequence, by signal not by default", () => {
  // Real backlog item that previously reached review only via the
  // ambiguous default -- right outcome, wrong reason.
  const result = assessClaimConsequence(
    "Staff who cover Saturday Sept 5th orientation will receive a full vacation day instead of hourly pay.",
  );
  assert.equal(result.level, "high");
  assert.equal(result.signal, "compensation_or_time_off");
});

test("bare comp-time terms of art are high consequence on their own", () => {
  assert.equal(assessClaimConsequence("Erika will take comp time for the weekend event.").signal, "compensation_or_time_off");
  assert.equal(assessClaimConsequence("This is handled as time off in lieu.").signal, "compensation_or_time_off");
});

test("ordinary vacation mentions are NOT escalated by the time-off pattern", () => {
  // Narrowness check: the granting-verb requirement is what keeps these out.
  assert.notEqual(assessClaimConsequence("On vacation from August 1-14, 2026.").signal, "compensation_or_time_off");
  assert.notEqual(assessClaimConsequence("Erika took a vacation day on Friday.").signal, "compensation_or_time_off");
  assert.notEqual(assessClaimConsequence("Is out of the office next week.").signal, "compensation_or_time_off");
});

test("'agrees with' reads as opinion, but 'agreed to fund' stays a commitment", () => {
  assert.equal(assessClaimConsequence("Greg agrees with the proposed AI internship language change.").level, "low");
  assert.equal(assessClaimConsequence("Rachael agreed with Peter's assessment.").level, "low");
  // The undertaking must not be softened by the new phrase.
  assert.equal(assessClaimConsequence("Greg agreed to fund the employer panel.").level, "high");
  assert.equal(assessClaimConsequence("Greg agreed to pay for the catering.").level, "high");
});

test("access and IT-support facts are low consequence", () => {
  assert.equal(
    assessClaimConsequence("Sarah Burrows does not have access to the my.suffolk.edu application.").level,
    "low",
  );
  assert.equal(assessClaimConsequence("Jan needed a password reset for Canvas.").level, "low");
});

test("routine scheduling facts are low consequence", () => {
  assert.equal(assessClaimConsequence("The 1:1 with Fouad was rescheduled to Thursday.").level, "low");
  assert.equal(assessClaimConsequence("Erika is available for a check-in next week.").level, "low");
});

test("ordinary opinion/support statements are low consequence", () => {
  assert.equal(assessClaimConsequence("Paul supports Erika's proposal for the panel format.").level, "low");
  assert.equal(assessClaimConsequence("Jordan is interested in joining the employer panel.").level, "low");
});

test("an unrecognized statement shape is ambiguous, never assumed safe", () => {
  assert.equal(assessClaimConsequence("The purple binder is on the third shelf.").level, "ambiguous");
});

test("a high signal wins outright when both are present", () => {
  // "access to" (low) + "approved" (high) -- must not be treated as routine.
  const result = assessClaimConsequence("Dave approved Sarah's access to the payroll system.");
  assert.equal(result.level, "high");
});

test("every outcome names the signal that produced it", () => {
  assert.equal(assessClaimConsequence("The budget is $3,000.").signal, "money");
  assert.equal(assessClaimConsequence("Meeting on Tuesday.").signal, "routine_scheduling");
  assert.equal(assessClaimConsequence("The purple binder is on the third shelf.").signal, null);
});

/* ------------------ integration with the review policy ----------------- */

test("a minor access fact now auto-saves instead of reaching Dave", () => {
  const result = tier({
    claimType: "fact",
    statement: "Sarah Burrows does not have access to the my.suffolk.edu application as of August 31, 2026.",
  });
  assert.equal(result.tier, "auto_save");
});

test("a routine scheduling fact auto-saves", () => {
  const result = tier({ claimType: "fact", statement: "The weekly check-in with Erika was rescheduled to Thursday." });
  assert.equal(result.tier, "auto_save");
});

test("a low-stakes support/opinion decision auto-saves", () => {
  const result = tier({ claimType: "decision", statement: "Paul supports Erika's proposal for the panel format." });
  assert.equal(result.tier, "auto_save");
});

test("a budget commitment decision still requires review", () => {
  const result = tier({
    claimType: "decision",
    statement: "Reduced the Career Ambassador budget to $3,000 from $4,000 for 2026-2027.",
  });
  assert.equal(result.tier, "review");
});

test("a contract deadline fact still requires review", () => {
  const result = tier({ claimType: "fact", statement: "The GrayDI vendor contract must be signed by September 1." });
  assert.equal(result.tier, "review");
});

test("a compensation policy decision still requires review", () => {
  const result = tier({
    claimType: "decision",
    statement: "Holiday coverage will now be compensated as a full vacation day.",
  });
  assert.equal(result.tier, "review");
});

test("an ambiguous decision requires review", () => {
  const result = tier({ claimType: "decision", statement: "The purple binder is on the third shelf." });
  assert.equal(result.tier, "review");
});

/* ---------------------- conservative types unchanged -------------------- */

test("relationship stays conservative -- personal/family content never auto-saves", () => {
  // The real backlog contained "X has a brother who lives in Israel". A
  // keyword list must never be the thing deciding that is safe to skip.
  const result = tier({
    claimType: "relationship",
    statement: "Sarah Burrows has a brother who lives in Israel.",
  });
  assert.equal(result.tier, "review");
});

test("relationship stays conservative even when it looks routine", () => {
  const result = tier({ claimType: "relationship", statement: "Erika supports Paul's idea." });
  assert.equal(result.tier, "review");
});

test("role, responsibility, and governing_context are untouched by the consequence gate", () => {
  for (const claimType of ["role", "responsibility", "governing_context"]) {
    const result = tier({ claimType, statement: "Meeting on Tuesday was rescheduled." });
    assert.equal(result.tier, "review", `expected ${claimType} to stay review`);
  }
});

test("sensitive keywords still block auto-save before consequence is consulted", () => {
  const result = tier({ claimType: "fact", statement: "Is out on medical leave; access to email is paused." });
  assert.equal(result.tier, "review");
});

test("weak evidence still blocks auto-save for a low-consequence fact", () => {
  const result = tier({
    claimType: "fact",
    statement: "Sarah may not have access to the my.suffolk.edu application.",
    evidenceStrength: "weak",
  });
  assert.equal(result.tier, "review");
});

test("a low-consequence fact affecting a Dave-confirmed claim still requires review", () => {
  const result = tier({
    claimType: "fact",
    statement: "Sarah does not have access to the my.suffolk.edu application.",
    relationship: "contradicts_existing",
    existingClaim: { claimType: "fact", confirmedByUser: true, isGoverningContext: false },
  });
  assert.equal(result.tier, "review");
});
