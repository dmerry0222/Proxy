import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createHeaderLookup,
  deterministicMailroomRoute,
  getHeader,
  hasHeader,
  headerContains,
  hasRealAttachments,
  normalizeOutlookMetadata,
} from "./src/lib/mailroom/normalizeOutlookMetadata.ts";

const fixtures = JSON.parse(await readFile(
  new URL("./test-fixtures/mailroom/outlook-header-cases.json", import.meta.url), "utf8"));

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const normalized = normalizeOutlookMetadata(fixture);
    assert.equal(deterministicMailroomRoute(normalized), fixture.expected.route);
    for (const [key, value] of Object.entries(fixture.expected)) {
      if (key !== "route") assert.equal(normalized[key], value, key);
    }
  });
}

test("header helpers are case-insensitive", () => {
  const lookup = createHeaderLookup([{ name: "LiSt-Id", value: "example.list" }]);
  assert.equal(getHeader(lookup, "list-id"), "example.list");
  assert.equal(hasHeader(lookup, "LIST-ID"), true);
  assert.equal(headerContains(lookup, "list-ID", "EXAMPLE"), true);
});

test("inline images are not meaningful attachments", () => {
  assert.equal(hasRealAttachments([{ isInline: true }]), false);
  assert.equal(hasRealAttachments([{ isInline: true }, { isInline: false }]), true);
});
