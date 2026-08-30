import test from "node:test";
import assert from "node:assert/strict";
import { diffDataSourceSchema, buildSchemaPatch } from "./src/lib/notion/schemaDiff.ts";

const EXPECTED = {
  Conversation: { type: "title", title: {} },
  Bucket: {
    type: "select",
    select: { options: [{ name: "Needs You" }, { name: "FYI" }, { name: "Calendar" }, { name: "Workday" }] },
  },
  "Requested Action": {
    type: "select",
    select: { options: [{ name: "Archive" }, { name: "Draft Reply" }] },
  },
  "Date Received": { type: "date", date: {} },
  Submitted: { type: "checkbox", checkbox: {} },
};

// Structurally the real pre-migration live schema.
const STALE = {
  Conversation: { type: "title", title: {} },
  Bucket: { type: "select", select: { options: [{ name: "FYI" }, { name: "Needs You" }] } },
  "Needs Action": { type: "checkbox", checkbox: {} },
  Archive: { type: "checkbox", checkbox: {} },
};

test("detects properties missing from the live schema", () => {
  const diff = diffDataSourceSchema(EXPECTED, STALE);
  assert.deepEqual(diff.missingProperties.sort(), ["Date Received", "Requested Action", "Submitted"]);
});

test("detects select options missing from an existing property", () => {
  const diff = diffDataSourceSchema(EXPECTED, STALE);
  assert.deepEqual(diff.missingSelectOptions, [{ property: "Bucket", options: ["Calendar", "Workday"] }]);
});

test("reports legacy properties as retained, not as drift to correct", () => {
  const diff = diffDataSourceSchema(EXPECTED, STALE);
  assert.deepEqual(diff.legacyProperties.sort(), ["Archive", "Needs Action"]);
  // Legacy properties must never appear in the patch payload.
  const patch = buildSchemaPatch(EXPECTED, STALE, diff);
  assert.equal("Needs Action" in patch, false);
  assert.equal("Archive" in patch, false);
});

test("a stale schema is not in sync; a compliant one is", () => {
  assert.equal(diffDataSourceSchema(EXPECTED, STALE).inSync, false);
  assert.equal(diffDataSourceSchema(EXPECTED, EXPECTED).inSync, true);
});

test("IDEMPOTENT: an already-compliant schema produces an empty patch", () => {
  const diff = diffDataSourceSchema(EXPECTED, EXPECTED);
  assert.deepEqual(buildSchemaPatch(EXPECTED, EXPECTED, diff), {});
});

test("select patch preserves options that exist only in Notion", () => {
  // A human-added option must survive the migration -- sending only the
  // expected set would delete it and orphan every page using it.
  const withCustom = {
    ...STALE,
    Bucket: { type: "select", select: { options: [{ name: "FYI" }, { name: "Needs You" }, { name: "Custom" }] } },
  };
  const diff = diffDataSourceSchema(EXPECTED, withCustom);
  const patch = buildSchemaPatch(EXPECTED, withCustom, diff);
  const names = patch.Bucket.select.options.map((o) => o.name);
  assert.ok(names.includes("Custom"), "human-added option was dropped");
  assert.ok(names.includes("Calendar") && names.includes("Workday"));
});

test("type mismatches are reported but never auto-patched", () => {
  const mistyped = { ...STALE, "Date Received": { type: "rich_text", rich_text: {} } };
  const diff = diffDataSourceSchema(EXPECTED, mistyped);
  assert.deepEqual(diff.typeMismatches, [{ property: "Date Received", expected: "date", actual: "rich_text" }]);
  const patch = buildSchemaPatch(EXPECTED, mistyped, diff);
  assert.equal("Date Received" in patch, false, "retyping would destroy stored data");
});

test("patch contains exactly the properties needing work", () => {
  const diff = diffDataSourceSchema(EXPECTED, STALE);
  const patch = buildSchemaPatch(EXPECTED, STALE, diff);
  assert.deepEqual(Object.keys(patch).sort(), ["Bucket", "Date Received", "Requested Action", "Submitted"]);
});
