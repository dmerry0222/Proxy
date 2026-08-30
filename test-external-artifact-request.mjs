import test from "node:test";
import assert from "node:assert/strict";
import {
  validateExternalArtifactRequest,
  externalArtifactIdentity,
  decodeBase64Content,
  mimeTypeForFilename,
  MAX_DECODED_BYTES,
} from "./src/lib/ingestion/externalArtifactRequest.ts";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function body(overrides = {}) {
  return {
    sourceSystem: "outlook",
    artifactType: "summary",
    contextHint: "meeting",
    filename: "meeting-notes.md",
    mimeType: "text/markdown",
    contentBase64: b64("# Notes\n\nDiscussed the CDC rollout."),
    title: "CDC sync",
    occurredAt: "2026-08-30T14:00:00Z",
    outlookMessageId: "AQMkAD...GraphId",
    internetMessageId: "<abc123@suffolk.edu>",
    emailSubject: "Meeting notes",
    sender: "msales@suffolk.edu",
    attachmentId: "ATT-001",
    ...overrides,
  };
}

/* ---------- validation ---------- */

test("a well-formed Power Automate payload validates", () => {
  const r = validateExternalArtifactRequest(body());
  assert.equal(r.ok, true);
  assert.equal(r.value.artifactType, "summary");
  assert.equal(r.value.contextHint, "meeting");
  assert.equal(r.value.sender, "msales@suffolk.edu");
});

test("filename and contentBase64 are required", () => {
  assert.match(validateExternalArtifactRequest(body({ filename: "" })).error, /filename is required/);
  assert.match(validateExternalArtifactRequest(body({ contentBase64: "  " })).error, /contentBase64 is required/);
});

test("a non-object body is refused", () => {
  for (const bad of [null, "a string", 42, ["array"]]) {
    assert.equal(validateExternalArtifactRequest(bad).ok, false);
  }
});

test("documented defaults apply when optional fields are omitted", () => {
  const r = validateExternalArtifactRequest({ filename: "notes.txt", contentBase64: b64("hi") });
  assert.equal(r.ok, true);
  assert.equal(r.value.sourceSystem, "outlook");
  assert.equal(r.value.artifactType, "attachment");
  assert.equal(r.value.contextHint, "auto");
  assert.equal(r.value.mimeType, "text/plain", "mime is inferred from the extension");
});

test("invalid enums are refused rather than coerced", () => {
  assert.match(validateExternalArtifactRequest(body({ artifactType: "nonsense" })).error, /artifactType must be one of/);
  assert.match(validateExternalArtifactRequest(body({ contextHint: "sideways" })).error, /contextHint must be one of/);
});

test("every documented artifactType and contextHint is accepted", () => {
  for (const t of ["transcript", "summary", "personal_notes", "agenda", "chat_export", "recording", "attachment", "other"]) {
    assert.equal(validateExternalArtifactRequest(body({ artifactType: t })).ok, true, t);
  }
  for (const h of ["auto", "general", "meeting"]) {
    assert.equal(validateExternalArtifactRequest(body({ contextHint: h })).ok, true, h);
  }
});

test("a non-ISO occurredAt is refused", () => {
  assert.match(validateExternalArtifactRequest(body({ occurredAt: "last tuesday" })).error, /ISO 8601/);
  assert.equal(validateExternalArtifactRequest(body({ occurredAt: null })).ok, true);
});

test("blank optional strings normalize to null, not empty strings", () => {
  const r = validateExternalArtifactRequest(body({ title: "   ", sender: "", attachmentId: "  " }));
  assert.equal(r.value.title, null);
  assert.equal(r.value.sender, null);
  assert.equal(r.value.attachmentId, null);
});

test("mime type is inferred for the formats meeting notes actually arrive as", () => {
  assert.equal(mimeTypeForFilename("a.vtt"), "text/vtt");
  assert.equal(mimeTypeForFilename("a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(mimeTypeForFilename("a.PDF"), "application/pdf");
  assert.equal(mimeTypeForFilename("a.weird"), "application/octet-stream");
  assert.equal(mimeTypeForFilename("noextension"), "application/octet-stream");
});

/* ---------- idempotency key ---------- */

test("IDEMPOTENCY: the immutable internet message id is preferred over the Graph id", () => {
  // The Graph id changes when Power Automate files the mail; keying on it
  // would let a retry create a second artifact.
  assert.equal(
    externalArtifactIdentity({ internetMessageId: "<abc@x>", outlookMessageId: "GRAPH-1", attachmentId: "A1" }),
    "<abc@x>:A1"
  );
  assert.equal(
    externalArtifactIdentity({ internetMessageId: "<abc@x>", outlookMessageId: "GRAPH-2-AFTER-MOVE", attachmentId: "A1" }),
    "<abc@x>:A1",
    "key must be stable across a folder move"
  );
});

test("IDEMPOTENCY: falls back to the Graph id when no internet message id exists", () => {
  assert.equal(
    externalArtifactIdentity({ internetMessageId: null, outlookMessageId: "GRAPH-1", attachmentId: "A1" }),
    "GRAPH-1:A1"
  );
});

test("IDEMPOTENCY: two attachments on one email are distinct artifacts", () => {
  const a = externalArtifactIdentity({ internetMessageId: "<m@x>", outlookMessageId: null, attachmentId: "A1" });
  const b = externalArtifactIdentity({ internetMessageId: "<m@x>", outlookMessageId: null, attachmentId: "A2" });
  assert.notEqual(a, b);
});

test("IDEMPOTENCY: null when there is nothing stable to key on", () => {
  assert.equal(externalArtifactIdentity({ internetMessageId: null, outlookMessageId: null, attachmentId: "A1" }), null);
  assert.equal(externalArtifactIdentity({ internetMessageId: "<m@x>", outlookMessageId: null, attachmentId: null }), null);
});

/* ---------- base64 decoding ---------- */

test("valid base64 decodes to the original bytes", () => {
  const r = decodeBase64Content(b64("hello world"));
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.bytes).toString("utf8"), "hello world");
});

test("newline-wrapped base64 from Power Automate decodes", () => {
  const wrapped = b64("a".repeat(200)).replace(/(.{40})/g, "$1\r\n");
  const r = decodeBase64Content(wrapped);
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.bytes).toString("utf8"), "a".repeat(200));
});

test("a data URI prefix is tolerated", () => {
  const r = decodeBase64Content(`data:text/plain;base64,${b64("hi")}`);
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.bytes).toString("utf8"), "hi");
});

test("CORRUPTION: invalid base64 is refused, not silently salvaged", () => {
  // Buffer.from ignores invalid characters, which would ingest garbage as
  // if it were a real artifact.
  assert.equal(decodeBase64Content("!!!not base64!!!").ok, false);
  assert.match(decodeBase64Content("abc").error, /not valid base64/, "length must be a multiple of 4");
});

test("empty content is refused", () => {
  assert.equal(decodeBase64Content("").ok, false);
  assert.equal(decodeBase64Content("   \n  ").ok, false);
});

test("oversized content is refused with a size-specific error", () => {
  const big = Buffer.alloc(1024, 1).toString("base64");
  const r = decodeBase64Content(big, 100);
  assert.equal(r.ok, false);
  assert.match(r.error, /limit is 100 bytes/);
});

test("the default ceiling is generous enough not to bite before the platform does", () => {
  // Vercel caps request bodies near 4.5 MB, so this must not be the
  // binding limit in production.
  assert.ok(MAX_DECODED_BYTES > 4.5 * 1024 * 1024);
});

test("binary payloads survive the round trip", () => {
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);
  const r = decodeBase64Content(bytes.toString("base64"));
  assert.equal(r.ok, true);
  assert.deepEqual(Buffer.from(r.bytes), bytes);
});
