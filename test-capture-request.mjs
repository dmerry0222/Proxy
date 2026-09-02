import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_SOURCES,
  DEFAULT_CAPTURE_TYPE,
  MAX_CONTENT_LENGTH,
  RECOGNIZED_CAPTURE_TYPES,
  capturePreview,
  validateCaptureRequest,
} from "./src/lib/capture/captureRequest.ts";

/* Built from char codes so this file never contains a raw control byte. */
const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/** The exact body the documented Drafts action sends. */
function draftsBody(overrides = {}) {
  return {
    source: "drafts",
    capture_type: "quick_add_task",
    content: "Email Alicia about the revised internship form",
    captured_at: "2026-09-02T13:45:00Z",
    metadata: {
      action: "Proxy Quick Task",
      draft_uuid: "F7A1C2E0-1111-2222-3333-444455556666",
      device: "iphone",
    },
    ...overrides,
  };
}

test("the documented Drafts payload validates and normalizes", () => {
  const result = validateCaptureRequest(draftsBody());
  assert.equal(result.ok, true);
  assert.equal(result.value.source, "drafts");
  assert.equal(result.value.captureType, "quick_add_task");
  assert.equal(result.value.content, "Email Alicia about the revised internship form");
  assert.equal(result.value.capturedAt, "2026-09-02T13:45:00.000Z");
  assert.equal(result.value.captureTypeRecognized, true);
  assert.equal(result.value.metadata.action, "Proxy Quick Task");
});

test("content is the only thing worth rejecting a capture over", () => {
  for (const bad of [{ content: "" }, { content: "   \n\t " }, { content: 42 }, { content: undefined }]) {
    const result = validateCaptureRequest(draftsBody(bad));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.match(result.error, /content/);
  }

  const tooLong = validateCaptureRequest(draftsBody({ content: "x".repeat(MAX_CONTENT_LENGTH + 1) }));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /limit is/);
});

test("content is stored whole -- a long ramble is a first-class capture", () => {
  const ramble = "So the thing about the internship form is ".repeat(500);
  const result = validateCaptureRequest(draftsBody({ capture_type: "long_ramble", content: ramble }));
  assert.equal(result.ok, true);
  assert.equal(result.value.content.length, ramble.trim().length);
});

test("an unknown capture_type is recorded, never rejected", () => {
  const result = validateCaptureRequest(draftsBody({ capture_type: "voice_memo_from_the_car" }));
  assert.equal(result.ok, true);
  assert.equal(result.value.captureType, "voice_memo_from_the_car");
  assert.equal(result.value.captureTypeRecognized, false);
});

test("every recognized capture type is flagged as recognized", () => {
  for (const type of RECOGNIZED_CAPTURE_TYPES) {
    const result = validateCaptureRequest(draftsBody({ capture_type: type }));
    assert.equal(result.ok, true);
    assert.equal(result.value.captureTypeRecognized, true, `${type} should be recognized`);
  }
});

test("capture_type is normalized so one intent is not two values", () => {
  for (const spelling of ["Quick Add Task", "quick-add-task", "QUICK_ADD_TASK"]) {
    const result = validateCaptureRequest(draftsBody({ capture_type: spelling }));
    assert.equal(result.value.captureType, "quick_add_task");
  }
});

test("capture_type defaults rather than failing when omitted", () => {
  const body = draftsBody();
  delete body.capture_type;
  const result = validateCaptureRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.captureType, DEFAULT_CAPTURE_TYPE);
});

test("source is a closed vocabulary, and every documented value is accepted", () => {
  for (const source of CAPTURE_SOURCES) {
    assert.equal(validateCaptureRequest(draftsBody({ source })).ok, true, source);
  }

  const typo = validateCaptureRequest(draftsBody({ source: "draft" }));
  assert.equal(typo.ok, false);
  assert.match(typo.error, /drafts, ios_shortcut, proxy_ui, share_sheet, nfc, other/);
});

test("an omitted source falls back to other rather than failing", () => {
  const body = draftsBody();
  delete body.source;
  const result = validateCaptureRequest(body);
  assert.equal(result.ok, true);
  assert.equal(result.value.source, "other");
});

test("the Drafts UUID becomes the dedup key without the client restating it", () => {
  const result = validateCaptureRequest(draftsBody());
  assert.equal(result.value.sourceExternalId, "F7A1C2E0-1111-2222-3333-444455556666");
});

test("an explicit source_external_id wins over metadata.draft_uuid", () => {
  const result = validateCaptureRequest(draftsBody({ source_external_id: "shortcut-run-99" }));
  assert.equal(result.value.sourceExternalId, "shortcut-run-99");
});

test("a capture with nothing stable to key on is still valid", () => {
  const result = validateCaptureRequest({ source: "nfc", content: "Left the office" });
  assert.equal(result.ok, true);
  assert.equal(result.value.sourceExternalId, null);
});

test("a bad captured_at warns instead of losing the capture", () => {
  const result = validateCaptureRequest(draftsBody({ captured_at: "yesterday afternoon" }));
  assert.equal(result.ok, true);
  assert.equal(result.value.capturedAt, null);
  assert.match(result.value.capturedAtWarning, /not an ISO 8601 timestamp/);
});

test("camelCase bodies work too -- hand-written JS should not lose a thought", () => {
  const result = validateCaptureRequest({
    source: "ios_shortcut",
    captureType: "note",
    content: "Parking garage level 3",
    capturedAt: "2026-09-02T13:45:00Z",
    sourceExternalId: "run-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.captureType, "note");
  assert.equal(result.value.sourceExternalId, "run-1");
});

test("metadata is passed through whole, whatever a client invents", () => {
  const result = validateCaptureRequest(
    draftsBody({ metadata: { action: "Proxy Ramble", nested: { gps: [42.35, -71.06] }, count: 3 } })
  );
  assert.deepEqual(result.value.metadata.nested, { gps: [42.35, -71.06] });
  assert.equal(result.value.metadata.count, 3);
});

test("a non-object metadata degrades to empty rather than rejecting", () => {
  for (const metadata of ["nope", 5, ["a"], null]) {
    const result = validateCaptureRequest(draftsBody({ metadata }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.metadata, {});
  }
});

test("non-object bodies are rejected clearly", () => {
  for (const body of [null, "text", 42, ["a"]]) {
    const result = validateCaptureRequest(body);
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON object/);
  }
});

test("unstorable control characters are stripped, not rejected", () => {
  // Postgres text cannot hold a NUL byte. Rejecting the capture would lose a
  // real thought over a byte the clipboard added; worse, the same byte in the
  // trace summary made the FAILURE invisible too.
  const result = validateCaptureRequest(
    draftsBody({ content: "Email Alicia" + NUL + " about the form" + BELL })
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.content, "Email Alicia about the form");
  assert.match(result.value.contentWarning, /Control characters/);
});

test("newlines and tabs survive -- a ramble keeps its shape", () => {
  const result = validateCaptureRequest(draftsBody({ content: "line one" + NL + NL + TAB + "line two" }));
  assert.equal(result.ok, true);
  assert.equal(result.value.content, "line one" + NL + NL + TAB + "line two");
  assert.equal(result.value.contentWarning, null);
});

test("content that is ONLY control characters is rejected as blank", () => {
  const result = validateCaptureRequest(draftsBody({ content: NUL + BELL }));
  assert.equal(result.ok, false);
  assert.match(result.error, /blank/);
});

test("the preview never carries a character that would break its own trace", () => {
  assert.equal(capturePreview("before" + NUL + "after"), "beforeafter");
});

test("the preview shortens for trace summaries without touching the content", () => {
  const long = "word ".repeat(200);
  const preview = capturePreview(long);
  assert.ok(preview.length <= 120);
  assert.match(preview, /…$/);
  assert.equal(capturePreview("short one"), "short one");
  assert.equal(capturePreview("line one\n\nline  two"), "line one line two");
});
