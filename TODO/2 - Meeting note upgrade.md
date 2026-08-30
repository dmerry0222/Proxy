# Enable Power Automate Meeting Artifact Ingestion

## Objective

Extend Proxy's existing artifact-ingestion architecture so Power Automate can send meeting-note attachments, initially Zoom meeting notes/transcripts received by email, directly into the **existing canonical artifact and Memory pipeline**.

Do **not** create a second meeting-processing system.

The existing code already contains most of what we need:

* `src/lib/ingestion/ingestArtifact.ts`

  * hashes/deduplicates artifacts
  * uploads originals to Supabase Storage bucket `meeting-artifacts`
  * creates `memory_sources`
  * creates `artifacts`
  * tracks `ingestion_jobs`
  * parses supported files
  * dispatches meetings to `processMeetingArtifact()`
* `src/lib/ingestion/parseDocument.ts`

  * PDF
  * DOCX
  * text/markdown
  * VTT
  * JSON
* `src/lib/ingestion/processMeetingArtifact.ts`

  * creates meeting source families
  * creates `meetings`
  * links artifacts/sources
  * matches calendar events
  * resolves participants
  * runs meeting knowledge extraction
* `src/lib/ingestion/matchCalendarEvent.ts`
* `src/lib/ingestion/extractMeetingKnowledge.ts`
* `src/lib/ingestion/adapters.ts`

  * already explicitly anticipates `ZoomAdapter` and `ForwardedEmailAttachmentAdapter`
* `src/app/api/ingestion/artifacts/route.ts`

  * currently provides manual multipart/form-data intake

The goal is therefore to add a **Power Automate transport/adapter into this pipeline**, not replace or duplicate any downstream functionality.

---

# 1. Add a machine-to-machine artifact intake endpoint

Create a dedicated API route such as:

`POST /api/ingestion/artifacts/external`

or another clearly named route consistent with the app.

It should accept JSON suitable for Power Automate.

Suggested contract:

```json
{
  "sourceSystem": "zoom_email",
  "artifactType": "summary",
  "externalId": "optional-provider-or-message-specific-id",
  "filename": "meeting-summary.docx",
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "contentBase64": "<base64 attachment content>",
  "title": "Optional meeting title",
  "occurredAt": "2026-08-25T14:00:00-04:00",
  "contextHint": "meeting",
  "metadata": {
    "transport": "power_automate",
    "internet_message_id": "...",
    "outlook_message_id": "...",
    "email_subject": "...",
    "email_sender": "...",
    "provider_meeting_id": "...",
    "attachment_id": "..."
  }
}
```

Not every optional value must be present.

Required minimum:

* `sourceSystem`
* `artifactType`
* `filename`
* `mimeType`
* `contentBase64`

For these Zoom-email artifacts, Power Automate should normally send:

```json
"contextHint": "meeting"
```

This is important because `shouldProcessAsMeeting()` already respects an explicit meeting context hint.

---

# 2. Reuse `ingestArtifact()` directly

The external route should:

1. validate the payload
2. validate allowed artifact types/context hints
3. decode `contentBase64` into bytes
4. reject malformed base64
5. enforce the same 50 MB decoded-size limit used by manual ingestion
6. call the existing:

```ts
ingestArtifact(...)
```

with something equivalent to:

```ts
await ingestArtifact({
  artifactType,
  sourceSystem,
  externalId,
  filename,
  mimeType,
  bytes,
  title,
  occurredAt,
  contextHint,
  submissionKind: "file",
  metadata
});
```

Do not reproduce Storage, parsing, Memory-source creation, meeting detection, calendar matching, or extraction logic inside the route.

There must continue to be **one canonical artifact pipeline**.

---

# 3. Secure the endpoint for Power Automate

This endpoint will be machine-to-machine and must not be anonymously writable.

Implement a simple server-side secret appropriate for this internal integration.

For example:

Environment variable:

```text
PROXY_INGESTION_SECRET
```

Power Automate sends:

```http
Authorization: Bearer <secret>
```

The route compares against the server-side value and returns `401` for invalid/missing credentials.

Do not expose the Supabase service-role key or any other privileged Supabase credential to Power Automate.

Do not put this secret in a `NEXT_PUBLIC_*` environment variable.

Keep the existing `supabaseServer` service-role access server-side.

---

# 4. Add a Power Automate / Zoom adapter

Use the existing abstraction in:

`src/lib/ingestion/adapters.ts`

rather than leaving its Zoom/forwarded-email comments permanently aspirational.

Create an adapter representing this transport/provider, for example:

* `PowerAutomateAttachmentAdapter`
* `ZoomEmailAttachmentAdapter`

Choose the division that produces the cleanest architecture.

My preference is:

### Transport

Power Automate

### Source system

Zoom email

Meaning Power Automate is how the bytes arrived, while Zoom is where the artifact originated.

For example:

```text
sourceSystem = "zoom"
metadata.transport = "power_automate"
metadata.transport_source = "outlook_email"
```

Avoid naming the canonical source system `power_automate`, because Memory should care primarily about the provenance of the content rather than which automation moved the bytes.

If the adapter abstraction adds unnecessary ceremony for a single JSON route, it is acceptable to keep the route thin and use an adapter only where it actually provides value. Do not refactor working ingestion code purely to satisfy the existing stub comment.

---

# 5. Improve external/provenance metadata preservation

Right now `ingestArtifact()` appropriately retains arbitrary `metadata`.

For meeting artifacts arriving from email, preserve enough transport provenance to get back to the source email later.

Support metadata such as:

```json
{
  "transport": "power_automate",
  "transport_source": "outlook_email",
  "internet_message_id": "...",
  "outlook_message_id": "...",
  "email_subject": "...",
  "email_sender": "...",
  "attachment_id": "...",
  "provider_meeting_id": "...",
  "provider": "zoom"
}
```

Do not require all of these fields.

Do not put provider-specific columns into canonical tables unless there is a compelling reason. Prefer `metadata` for provider/transport details.

---

# 6. Make duplicate delivery harmless

Power Automate can retry HTTP actions, and flows may accidentally submit the same attachment more than once.

The current content-hash dedupe in `ingestArtifact()` already gives us a strong foundation.

Preserve it.

Also inspect whether `external_id` can usefully provide a second idempotency signal, such as a deterministic combination of:

```text
outlook_message_id + attachment_id
```

Do not weaken content-hash dedupe.

A duplicate submission should return a normal successful/idempotent result rather than create another meeting or another Memory extraction.

Power Automate should be able to interpret a response like:

```json
{
  "duplicate": true,
  "artifactId": "...",
  "meetingId": "...",
  "sourceId": "..."
}
```

as success.

---

# 7. Make meeting metadata useful before parsing

Zoom-generated attachments may not contain Proxy's custom frontmatter.

Power Automate will often know useful context that the document itself does not expose cleanly.

Ensure the canonical pipeline can take advantage of input metadata such as:

* meeting title/email subject
* meeting datetime
* Zoom meeting ID
* calendar event ID, if available
* participants, if available

At minimum, `title` and `occurredAt` supplied by the external request should flow through exactly as they currently can via `IngestionInput`.

Review whether `processMeetingArtifact()` only obtains participants from parsed frontmatter. It currently appears to derive participant emails from:

* `participants`
* `attendees`
* `participant_emails`

in parsed frontmatter.

For external meeting ingestion, extend this carefully so participant emails provided through trusted `input.metadata` can also be passed into meeting processing/calendar matching.

Do this through the canonical function signatures rather than manufacturing fake frontmatter.

For example, `processMeetingArtifact()` could accept explicit participant metadata in addition to parsed document content.

Likewise, if `metadata.calendar_event_id` or `metadata.provider_meeting_id` is present, preserve it and use deterministic identifiers where appropriate before falling back to fuzzy calendar matching.

Do not remove the existing time/title/participant matcher. It remains the fallback.

---

# 8. Avoid creating separate meetings for multiple artifacts from one meeting

This is the most important architectural issue to inspect.

Currently, `processMeetingArtifact()` appears to create:

1. a new `memory_source_families` meeting family
2. a new `meetings` row

for each processed meeting artifact.

That is fine for a single manually uploaded document, but Zoom may send multiple artifacts for one meeting:

* summary
* transcript
* chat
* possibly additional notes

Those should become sibling sources/artifacts under **one canonical meeting**, not four different meetings.

Before enabling automated Zoom ingestion, make meeting resolution idempotent.

Use the strongest available identity in roughly this order:

1. explicit existing `meeting_id`
2. provider + `provider_meeting_id` + occurrence datetime
3. explicit `calendar_event_id`
4. strong calendar-event match
5. only then create a new meeting

For recurring Zoom meetings, do not assume Zoom's reusable meeting ID alone identifies an occurrence. Include occurrence/start time or equivalent occurrence identity.

Desired model:

```text
Meeting
├── Zoom AI summary
├── Zoom transcript
├── Zoom chat
├── Calendar event
└── eventually Dave's own notes
```

not:

```text
Meeting created from summary
Meeting created from transcript
Meeting created from chat
```

Inspect the existing schema before deciding what uniqueness/index changes are necessary.

Prefer linking additional `artifacts` and `memory_sources` to the existing meeting/source family over creating redundant meeting records.

This change must remain compatible with current manual uploads.

---

# 9. Artifact-type inference

Power Automate should be allowed to specify `artifactType`, but add conservative inference for common filenames/MIME types when useful.

Examples:

* `.vtt` → `transcript`
* filename containing `transcript` → `transcript`
* filename containing `summary` / `meeting summary` → `summary`
* filename containing `chat` → `chat_export`
* otherwise → `attachment`

Do not rely exclusively on filename inference if Power Automate has supplied an explicit valid type.

Do not classify every Zoom attachment as a transcript.

---

# 10. Maintain existing parsing behavior

Do not broaden parsing unless the actual Zoom files demonstrate a missing format.

Current support includes:

* PDF
* DOCX
* TXT
* Markdown
* VTT
* JSON

Unknown types should continue to be safely stored with `storedOnly: true` rather than rejected or discarded.

This is a good behavior and should remain.

---

# 11. Response contract for Power Automate

Return machine-readable JSON.

Success:

```json
{
  "success": true,
  "duplicate": false,
  "artifactId": "...",
  "sourceId": "...",
  "meetingId": "...",
  "contentKind": "meeting",
  "calendarMatch": {},
  "sectionsCreated": 4,
  "tasksCreated": 2,
  "claimsCreated": 3,
  "pendingContextCreated": 1,
  "warnings": []
}
```

Duplicate:

```json
{
  "success": true,
  "duplicate": true,
  "artifactId": "...",
  "meetingId": "..."
}
```

Bad input:

HTTP 400

Unauthorized:

HTTP 401

Too large:

HTTP 413

Unexpected processing failure:

HTTP 500 with a safe error message.

Do not return secrets or Supabase credentials.

---

# 12. Do not require a separate Memory sync ping for each artifact

Review this carefully.

The current artifact pipeline already calls meeting-specific knowledge extraction synchronously through:

```text
ingestArtifact
→ processMeetingArtifact
→ extractMeetingKnowledge
```

Therefore a successfully processed artifact is already in Memory.

Do **not** blindly trigger the existing email/calendar/Teams `source_sync_runs` pipeline afterward unless there is some distinct downstream work that actually needs it.

The existing `source_sync_runs` system currently recognizes:

* Teams
* calendar
* email

and is designed around those source synchronization semantics.

Artifact ingestion already has its own:

* `artifacts`
* `ingestion_jobs`
* processing status
* Memory source creation

Keep those concepts separate unless there is a strong architectural reason to unify them.

If Proxy needs a generic "new Memory material processed" event later, design that deliberately rather than abusing an email source-sync run.

---

# 13. Optional batch endpoint

Because one Zoom email may contain several attachments, consider supporting either:

### Simple option

Power Automate calls the external endpoint once per attachment.

This is perfectly acceptable initially and probably preferable.

### Future option

One request contains multiple attachments.

Do not implement batching merely for elegance if it substantially complicates failure/retry semantics.

Per-attachment calls have a major advantage: Power Automate can retry one failed file without retransmitting everything.

Use per-attachment submission for the first implementation unless there is a compelling existing reason not to.

---

# 14. Testing

Add tests or a repeatable test harness covering at least:

### Authentication

* missing secret → 401
* incorrect secret → 401
* valid secret → accepted

### Base64

* valid base64 decodes correctly
* malformed base64 → 400
* decoded payload over limit → 413

### Meeting summary

Send a small text/markdown or DOCX meeting summary with:

```text
sourceSystem = zoom
contextHint = meeting
```

Confirm:

* Storage object exists
* `artifacts` row exists
* `memory_sources` row exists
* meeting exists
* artifact is linked to meeting
* meeting source family exists
* ingestion job completes
* document sections are created
* Memory extraction runs

### Transcript

Submit a VTT transcript and confirm it becomes:

```text
artifact_type = transcript
source_type = meeting_transcript
content_kind = meeting
```

### Duplicate

Submit identical bytes twice.

Confirm the second request does not create:

* another artifact
* another Memory source
* another meeting
* another extraction

### Multiple files, one meeting

Submit a summary and transcript sharing the same meeting identity.

Confirm:

```text
1 meeting
2 artifacts
2 appropriate Memory sources
1 meeting source family
```

This is a required acceptance test.

### Calendar matching

Supply enough title/time/context to match an existing calendar event.

Confirm the existing calendar-link architecture is reused.

---

# 15. Documentation for the Power Automate side

When implementation is complete, give me an exact integration contract I can paste into/build in Power Automate.

Specifically report:

1. the endpoint URL/path
2. HTTP method
3. required headers
4. exact JSON body template using Power Automate expressions where possible
5. which Outlook dynamic fields map to:

   * filename
   * MIME type
   * attachment content/base64
   * Outlook message ID
   * Internet Message ID
   * attachment ID
   * subject/title
   * received/meeting time
6. expected success response
7. how the flow should treat `duplicate: true`
8. recommended sender/subject conditions for Zoom emails
9. whether `Get attachments` plus `Get attachment content` is required for the version of the Outlook connector being used
10. any deployment/environment variable steps required

Do not fabricate Power Automate field names if the exact trigger/action output is uncertain. Clearly identify anything that should be verified against an actual Zoom message payload.

---

# 16. Architectural constraints

Please preserve these principles:

* Power Automate is a transport layer, not the intelligence layer.
* Supabase Storage is Proxy's durable canonical file storage.
* Postgres contains metadata/relationships, not base64 file blobs.
* `ingestArtifact()` remains the canonical artifact processing pipeline.
* Original files are retained.
* Parsed text becomes Memory-source content.
* Provider metadata remains inspectable.
* Meeting artifacts converge onto canonical meetings.
* Calendar events are evidence/context for meetings, not competing meeting records.
* Duplicate delivery is harmless.
* Unknown file formats are stored rather than lost.
* No privileged Supabase credential is exposed to Power Automate.
* Do not create a second Zoom-only Memory extraction architecture.

---

## Desired end state

The operational flow should be:

```text
Zoom sends meeting-notes email
        ↓
Outlook
        ↓
Power Automate identifies Zoom sender/subject
        ↓
Get Attachments / Get Attachment Content
        ↓
POST attachment + metadata to Proxy external artifact endpoint
        ↓
decode bytes
        ↓
existing ingestArtifact()
        ↓
Supabase Storage: original artifact
        ↓
artifacts + memory_sources + ingestion_jobs
        ↓
parseDocument()
        ↓
resolve/create canonical Meeting
        ↓
calendar match + participants
        ↓
extractMeetingKnowledge()
        ↓
claims / pending context / task candidates / evidence
```

The important engineering goal is not "support Zoom." It is:

> **Allow trusted external automation to feed files into Proxy's existing canonical artifact ingestion system, while making meeting identity robust enough that multiple artifacts from one meeting become one meeting bundle.**

Please inspect the existing Supabase schema and current code before changing anything, make the minimum coherent schema/code changes necessary, and verify the complete path end-to-end.
