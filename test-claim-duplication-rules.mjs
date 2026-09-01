import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMonetaryAmounts,
  extractPercentages,
  valuesConflict,
} from "./src/lib/memory/claimDuplicationRules.ts";
import {
  classifyClaimRelationshipDeterministically,
  propositionSimilarity,
} from "./src/lib/memory/claimReconciliationRules.ts";

const existing = (statement, overrides = {}) => ({
  id: "existing-1",
  statement,
  status: "candidate",
  confirmed_by_user: false,
  evidence_strength: "moderate",
  claim_type: "decision",
  is_governing_context: false,
  ...overrides,
});

test("monetary amounts are extracted and normalized", () => {
  assert.deepEqual(extractMonetaryAmounts("budget is $3,000 this year"), [3000]);
  assert.deepEqual(extractMonetaryAmounts("from $4,000 to $3,000.50"), [4000, 3000.5]);
  assert.deepEqual(extractMonetaryAmounts("no amounts here"), []);
});

test("percentages are extracted in both notations", () => {
  assert.deepEqual(extractPercentages("a 15% increase"), [15]);
  assert.deepEqual(extractPercentages("a 7.5 percent cut"), [7.5]);
});

test("the tokenizer genuinely cannot see amounts -- this is why the guard exists", () => {
  // Regression anchor: if this ever stops being 1.0, the value guard's
  // rationale has changed and should be re-examined rather than trusted.
  const similarity = propositionSimilarity(
    "The Career Ambassador budget is $3,000 for this year",
    "The Career Ambassador budget is $4,000 for this year",
  );
  assert.equal(similarity, 1);
});

test("different asserted amounts are a value conflict", () => {
  assert.equal(valuesConflict("budget is $3,000", "budget is $4,000"), true);
});

test("a subset of amounts is NOT a conflict (the real Career Ambassador cluster)", () => {
  // "Reduced ... to $3,000 from $4,000" carries {3000,4000};
  // "budget for this year is $3,000" carries {3000}. Same decision.
  assert.equal(
    valuesConflict(
      "Reduced the Career Ambassador budget to $3,000 from $4,000 for 2026-2027",
      "The Career Ambassador Program budget for this year is $3,000",
    ),
    false,
  );
});

test("statements without amounts never conflict on value", () => {
  assert.equal(valuesConflict("Erika owns the program", "Erika owns the program budget"), false);
});

test("near-identical wording with a DIFFERENT amount does not collapse into a duplicate", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "The Career Ambassador budget is $4,000 for this year",
    existing("The Career Ambassador budget is $3,000 for this year"),
  );
  assert.notEqual(outcome, "duplicates_existing");
  assert.notEqual(outcome, "supports_existing");
  assert.equal(outcome, "contradicts_existing");
});

test("a confirmed claim cannot absorb a conflicting amount either", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "The Career Ambassador budget is $4,000 for this year",
    existing("The Career Ambassador budget is $3,000 for this year", { confirmed_by_user: true }),
  );
  assert.equal(outcome, "contradicts_existing");
});

test("genuinely near-identical propositions still collapse", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "Sarah Burrows does not have access to the my.suffolk.edu application as of August 31, 2026.",
    existing("Sarah Burrows does not have access to the my.suffolk.edu application as of August 31, 2026.", {
      claim_type: "fact",
    }),
  );
  assert.equal(outcome, "duplicates_existing");
});

test("the same budget decision restated more briefly still collapses", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "The Career Ambassador Program budget is $3,000, based on prior year spend of $2,327.17",
    existing("The Career Ambassador Program budget is $3,000 based on prior year spend of $2,327.17"),
  );
  assert.ok(
    ["duplicates_existing", "supports_existing"].includes(outcome),
    `expected a collapse-safe outcome, got ${outcome}`,
  );
});

test("a later state-change is NOT swallowed by the earlier state", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "The Career Ambassador budget changed from $3,000 to $4,000 for 2026-2027",
    existing("The Career Ambassador budget is $3,000 for 2026-2027"),
  );
  assert.equal(outcome, "supersedes_existing");
});

test("a negation flip is still treated as a contradiction, not a duplicate", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "Sarah Burrows does not have access to the my.suffolk.edu application",
    existing("Sarah Burrows has access to the my.suffolk.edu application", { claim_type: "fact" }),
  );
  assert.equal(outcome, "contradicts_existing");
});

test("unrelated statements about the same entity are not collapsed", () => {
  const outcome = classifyClaimRelationshipDeterministically(
    "Erika Marshall is presenting at the October employer panel",
    existing("The Career Ambassador budget is $3,000 for this year"),
  );
  assert.equal(outcome, null);
});
