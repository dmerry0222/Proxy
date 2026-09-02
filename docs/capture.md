# Capture

`POST /api/capture` is Proxy's front door for **intentional** user input: a
thought you deliberately hand to Proxy from Drafts, an iOS Shortcut, the Proxy
UI, a Share Sheet action, or an NFC tag.

It is deliberately dumb. It authenticates, validates, writes the capture down,
and acknowledges it. It does **not** classify, route, or interpret — that is a
separate concern with a separate failure mode, and coupling them would mean a
classifier outage loses the thought. The lifecycle columns and
`setCaptureStatus()` exist so a processor can be added later without changing
anything a Drafts action was written against.

## Endpoint

```
POST https://<your-proxy-host>/api/capture
Content-Type: application/json
Authorization: Bearer <PROXY_CAPTURE_SECRET>
```

`X-Proxy-Capture-Secret: <secret>` is accepted as an alternative to the
`Authorization` header, for clients that reserve `Authorization` for their own
use. Both carry the same secret.

`PROXY_CAPTURE_SECRET` is dedicated to this endpoint — separate from
`PROXY_INGESTION_SECRET` (which lives in a Power Automate flow) and
`PROXY_ADMIN_API_TOKEN` (which lives in a terminal). This one lives on a
phone, so rotating it must not break Outlook attachment ingestion.

## Request body

```json
{
  "source": "drafts",
  "capture_type": "quick_add_task",
  "content": "Email Alicia about the revised internship form",
  "captured_at": "2026-09-02T13:45:00Z",
  "metadata": {
    "action": "Proxy Quick Task",
    "draft_uuid": "F7A1C2E0-1111-2222-3333-444455556666",
    "device": "iphone"
  }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `content` | **yes** | The only field that can get a capture rejected. Must not be blank. Up to 100,000 characters — a dictated ramble is a first-class capture. |
| `source` | no (default `other`) | Closed vocabulary: `drafts`, `ios_shortcut`, `proxy_ui`, `share_sheet`, `nfc`, `other`. An unrecognized value is a **400** — it is far more likely a typo in a Shortcut than a new integration. |
| `capture_type` | no (default `quick_add`) | **Extensible free string, not an enum.** Recognized today: `quick_add`, `quick_add_task`, `long_ramble`, `note`, `idea`, `log`. Anything else is accepted, stored as sent, and flagged. Normalized to lowercase with `_` separators, so `Quick Add Task` and `quick-add-task` both become `quick_add_task`. |
| `captured_at` | no | Your clock. Unparseable values are ignored with a warning, never a rejection — Proxy stamps `received_at` itself. |
| `source_external_id` | no | The dedup key. If omitted, `metadata.draft_uuid` is used automatically. |
| `metadata` | no | Free-form JSONB. Put anything in it. `metadata.action` is descriptive provenance, not a controlled value. |

`camelCase` keys (`captureType`, `capturedAt`, `sourceExternalId`) work as
well as `snake_case`.

## Responses

**201 Created** — a new capture:

```json
{
  "success": true,
  "duplicate": false,
  "captureId": "d1f3d6ba-f1a1-485f-87bc-0b39c45a8ed3",
  "source": "drafts",
  "captureType": "quick_add_task",
  "captureTypeRecognized": true,
  "processingStatus": "received",
  "capturedAt": "2026-09-02T13:45:00.000Z",
  "receivedAt": "2026-09-02T13:45:02.118Z",
  "traceId": "7bc54484-7d21-4c56-a328-ff8200726920"
}
```

`captureId` is Proxy's own ingestion id — the thing to log or display.

**200 OK** — a duplicate. Same shape, plus:

```json
{ "duplicate": true, "duplicateReason": "source_external_id", "captureId": "…the original…" }
```

`duplicateReason` is `source_external_id` (a retry) or `concurrent_insert`
(two requests racing). **This is a success, not an error**: 200 rather than
409 precisely so a retrying client stops retrying. The `captureId` returned is
the original capture's.

**Warnings** may appear on a 201 alongside `warnings: [...]` — an unparseable
`captured_at`, or control characters removed from `content`. The capture was
still saved.

| Status | Meaning | What to do |
| --- | --- | --- |
| **201** | Captured. | Done. |
| **200** | Already captured (retry). | Done — do not retry again. |
| **400** | Blank/missing `content`, an unknown `source`, or a non-JSON body. `error` says which. | Fix the client; retrying will not help. |
| **401** | Missing or wrong secret. | Check the header and the secret. |
| **500** | Proxy could not write the capture. | **Retry.** The thought is still on your device; a retry is the only thing that can save it. |

Every 400/401/500 also opens a `diagnostic_issues` row, so a broken client is
discoverable in Inspector General instead of failing silently on a phone.

## Deduplication

Uniqueness is `(source, source_external_id)`. A Drafts action that fires twice,
a double-tapped NFC tag, or a Shortcut retried on a flaky connection all
collapse onto one capture.

Captures with **no** external id are never deduplicated — "Call Alicia"
captured twice on purpose is two captures, and a content-hash rule here would
silently discard the second.

## From Drafts (JavaScript action step)

```javascript
const PROXY_URL = "https://<your-proxy-host>/api/capture";
const PROXY_SECRET = "<PROXY_CAPTURE_SECRET>";   // Drafts → Settings → Credentials

const http = HTTP.create();
const response = http.request({
  url: PROXY_URL,
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${PROXY_SECRET}`,
  },
  data: {
    source: "drafts",
    capture_type: "quick_add_task",     // or long_ramble, note, idea, log…
    content: draft.content,
    captured_at: new Date().toISOString(),
    metadata: {
      action: "Proxy Quick Task",       // free text: which action sent this
      draft_uuid: draft.uuid,           // makes the retry idempotent
      device: "iphone",
    },
  },
});

if (response.success) {
  const body = JSON.parse(response.responseText);
  // 200 with duplicate:true means an earlier run already captured this draft.
  app.displaySuccessMessage(
    body.duplicate ? "Already captured" : `Captured ${body.captureId.slice(0, 8)}`
  );
  draft.addTag("proxy-captured");
  draft.update();
} else {
  // 5xx: leave the draft alone and let the next run retry it.
  app.displayErrorMessage(`Proxy capture failed (${response.statusCode})`);
  context.fail();
}
```

Because `draft.uuid` is stable, re-running the action on the same draft is
safe: the second run returns the first run's `captureId` and creates nothing.

## Observability

Every capture opens a `diagnostic_traces` row in module `capture` and emits
events tagged `object_type: "capture"`, `object_id: <captureId>` — the same
convention Memory and ingestion use, so Inspector General's object lookup
works with no special-casing:

```
/inspector-general?objectType=capture&objectId=<captureId>
```

A trace summary reads as the provenance chain:

```
drafts → quick_add_task → received: Email Alicia about the revised internship form
```

Events emitted: `capture_received`, `capture_duplicate`,
`capture_type_unrecognized`, `capture_accepted_with_warning`, `capture_failed`.
The Inspector General overview carries a **Capture** health tile (stale after
14 days — capture is bursty and human-driven, so the tile is really watching
for captures that arrive and *fail*).

## Lifecycle

`received → processing → processed | failed`, on `captures.processing_status`,
with `processing_error` carrying the reason on failure.

Today every capture stops at `received`, and the trace completes there — that
IS the finished state for this endpoint. Leaving traces open awaiting a
processor that does not exist would make every healthy capture look stuck and
hide the first real failure among them. A future processor advances the status
through `setCaptureStatus()` so the states stay consistent.

## What a capture becomes

The raw capture is preserved permanently, including after it produces
downstream objects — which is what makes it re-runnable when the processor
improves. Each output uses the pointer mechanism that already exists for its
destination:

| Output | How it points back |
| --- | --- |
| Execution item | `execution_items.source_system = 'capture'`, `source_ref = captures.id` (the unique index keeps it to one item per capture) |
| Evidence | `execution_evidence.source_type = 'capture'`, `source_locator = {"capture_id": "…"}` |
| Memory | `memory_sources.source_type = 'user_statement'`, `canonical_table = 'captures'`, `canonical_record_id = captures.id`, and `captures.memory_source_id` pointing back |

## Testing

```bash
npm run test:capture-request          # 22 unit tests, no server needed
node scripts/capture-smoke.mjs        # live end-to-end; cleans up after itself
PROXY_BASE_URL=https://… node scripts/capture-smoke.mjs
```
