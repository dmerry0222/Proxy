# Teams + Calendar Memory expansion: inspection and plan

Status: proposal — inspection only, no code changed.

This is the first deliverable requested for extending Proxy Memory to learn
continuously from Teams messages and calendar events, per the governing
brief: Teams is conversational evidence, upcoming calendar is
contextualize-and-prepare, past calendar is reconcile-and-learn.

## 0. Inspection method and a gap to flag up front

This plan was built by reading the checked-in code that already touches
Teams, Calendar, and Memory (listed below), plus `AGENTS.md`. The Supabase
MCP connector is unauthenticated in this session, so live schema (exact
columns, constraints, and whether `source_sync_runs` /
`complete_teams_sync` already exist) could not be queried directly. Every
schema claim below is inferred from what the application code actually
selects/inserts. **Before any migration is written, re-confirm the live
schema** (columns, constraints, indexes) for `teams_messages`,
`calendar_events`, `memory_sources`, `memory_source_families`, and whether
`source_sync_runs`/`complete_teams_sync` already exist — either by
authorizing the Supabase MCP connector or a direct SQL check.

## 1. Current Teams schema (as observed in code)

Canonical table: `public.teams_messages`. Fields referenced by existing
code: `message_id` (PK, addressed 1:1), `chat_id`, `message_type`,
`sender_user_id`, `sender_display_name`, `created_at`, `body_text`,
`body_html`, `attachments`, `mentions`. `AGENTS.md` additionally lists
`last_modified_at`, `citations`, `reactions`, `etag`, `snapshot_time`,
`run_guid` as existing columns not yet read by any Memory code — these
matter for edit detection and sync-boundary correlation and should be
pulled into the new processing.

Sender resolution today goes through `org_chart` (`employeeid` ->
`employeeemail`/`employee_upn`) and then
`resolveMemoryEntityByEmail` (`src/lib/memory/resolveEntity.ts`), reusing
the same deterministic entity-resolution path as email.

## 2. Current Calendar schema (as observed in code)

Canonical table: `public.calendar_events`. Fields referenced across
`matchCalendarEvent.ts`, `loadDashboard.ts`, `reconcileWorkBlocks.ts`, and
`mutateExecute.ts`: `event_id` (PK/canonical, per
`execute-implementation-proposal.md`), `subject`, `start_time`,
`end_time`, `organizer`, `attendees` (`{ required?: string[], optional?:
string[] }`), `show_as`. `execute-implementation-proposal.md` also states
the table already carries availability, recurrence, response, and Outlook
timestamps — these fields are not yet read by any code in this repo and
their exact names need live-schema confirmation before fingerprinting
(section 11) is implemented.

There is no Memory-facing calendar ingestion today. Calendar is currently
only consumed by Execute (scheduling/reconciliation) and by ingestion's
`matchCalendarEvent` (corroborating meeting artifacts).

## 3. Current Memory ingestion pathways

- `src/lib/memory/ingestEmail.ts` — one email -> one Claude call -> up to
  2 claims + 1 pending-context item, gated by
  `memory_sources.metadata.memory_ingestion_version` (idempotent,
  versioned re-processing). This is the most mature pathway and the
  template for extraction discipline (strict volume caps, redaction,
  temporal grounding, ownership-signal gating).
- `src/lib/memory/ingestTeamsMessage.ts` — **already exists**, but
  processes **one Teams message at a time** (one Claude call per message).
  This directly conflicts with the brief's reasoning-granularity mandate
  (batch conversational deltas, not one-message-one-call). It also writes
  `source_type: "other"` because `memory_sources.source_type` has no
  `teams` member yet. This file should be replaced by the batched design
  in section 7, not extended.
- `src/lib/memory/backfillTeamsMessages.ts` — drives the per-message
  ingester above over a recent window; will need to become a
  per-conversation batch driver instead.
- `src/lib/ingestion/ingestArtifact.ts` — the best existing template for
  source-family usage: creates one `memory_source_families` row
  (`family_type: "meeting"`) per meeting, then one `memory_sources` row
  per artifact linked via `source_family_id`. This is the pattern Teams
  conversations and Calendar meeting-families should follow (section 14).
- `src/app/api/memory/*-test` routes — thin, manually-triggered Route
  Handlers wrapping the lib functions above. No cron/worker infra exists
  in this repo; every batch/background job (Mailroom included) is
  triggered by an external caller (Power Automate) hitting a plain Route
  Handler (`src/app/api/mailroom/run/route.ts` is the clearest example).
  The Teams/Calendar design should follow this same externally-triggered
  model rather than introducing an in-app scheduler.

## 4. Mapping Teams messages into `memory_sources` / `memory_source_families`

- One `memory_source_families` row per Teams `chat_id`
  (`family_type: "teams_conversation"`, `name` = chat topic/participants
  summary if available, `metadata: { chat_id }`). Created lazily on first
  message seen for that chat, mirroring the meeting-family creation in
  `ingestArtifact.ts`.
- One `memory_sources` row per Teams message, addressed by
  `canonical_table: "teams_messages"`, `canonical_record_id: message_id`,
  `source_family_id` pointing at the chat's family — same
  find-or-create-by-canonical-address idiom already used for email and
  the current Teams code. Each message stays individually
  provenance-addressable (per brief section 2), even though reasoning
  happens at the batch level.
- `memory_sources.source_type` needs a real `teams_message` (or similar)
  enum member. The current `"other"` workaround loses filterability and
  should be fixed as part of this work's migration (section 12), not
  carried forward.
- Edits: when `last_modified_at` differs from what was last processed,
  update the existing `memory_sources.content_text`/`metadata` in place
  (same row, new `content_fingerprint`) rather than creating a duplicate
  source — this is what makes edited messages eligible for reconciliation
  per section 3 of the brief.

## 5. Per-conversation Teams high-water-mark mechanism

Store state on the `memory_source_families` row for that `chat_id`
(`metadata` jsonb), not a new table — this mirrors the
`memory_ingestion_version`/`memory_ingested_at` idiom already used on
`memory_sources` for email and Teams idempotency:

```
memory_source_families.metadata = {
  chat_id: "...",
  teams_processor_version: 1,
  last_processed_message_id: "...",
  last_processed_message_at: "2026-08-24T13:05:00Z",
  last_processed_edit_at: "2026-08-24T13:05:00Z",   // max(last_modified_at) considered
  last_batch_fingerprint: "sha256:...",              // guards no-op reprocessing
  last_sync_run_guid: "..."                          // last source_sync_runs.run_guid consumed
}
```

A conversation's "new since last time" set is: messages in that `chat_id`
where `created_at > last_processed_message_at`, OR
`last_modified_at > last_processed_edit_at` (materially-edited messages,
per section 3's Friday->Monday example). This is a per-chat query, not a
global scan, so it stays cheap even though the trigger (section 6) is
global.

## 6. How `source_sync_runs` triggers/queues Teams Memory work

Per `AGENTS.md`, Power Automate now calls `public.complete_teams_sync`,
which writes a `source_sync_runs` row (`source = 'teams'`,
`memory_status = 'pending'`) — this table/function's existence in the
live database is the section-0 gap that needs confirming before this is
built.

Proposed flow, following the existing externally-triggered pattern (no
in-app cron):

1. New Route Handler, e.g. `POST /api/memory/teams/process-sync`,
   triggered by Power Automate immediately after `complete_teams_sync`
   (same call site, next step) — mirroring how Power Automate already
   drives Mailroom via a plain HTTP call.
2. The handler reads the oldest `source_sync_runs` row with
   `source = 'teams'` and `memory_status = 'pending'`.
3. It determines the set of `chat_id`s touched since the *previous*
   completed run (distinct `chat_id` in `teams_messages` with
   `created_at`/`last_modified_at` after the prior run's completion, or
   simply "all chats with a family whose high-water-mark is behind
   latest" — the per-chat state in section 5 makes this safe even if the
   candidate set is computed loosely).
4. For each touched chat, run the batch processor (section 7).
5. Mark the `source_sync_runs` row `memory_status = 'processed'` (or
   `'failed'` with an error) only after all chats attempted — a partial
   failure should not silently drop the sync boundary; log per-chat
   failures and let the per-chat high-water-mark (section 5) naturally
   retry just the chats that didn't advance on the next sync.

This keeps "when to look" (the sync-complete signal) separate from "what
is new" (the per-chat high-water-mark), exactly as the brief specifies.

## 7. Proposed Teams processing unit

Replace `ingestTeamsMessageToMemory` (one message, one call) with a
per-chat batch function, e.g. `processTeamsConversationDelta(chatId)`:

1. Load the family's high-water-mark state (section 5).
2. Load new/materially-edited messages for that chat since the mark,
   ordered by `created_at`, capped at a reasonable window (e.g. last N
   messages or last 48h, whichever is smaller — Teams chatter can be
   bursty).
3. Resolve each sender via `org_chart` -> `resolveMemoryEntityByEmail`
   (reuse `resolveTeamsSender` from the current file).
4. Skip the batch entirely (advance the mark, no Claude call) if every
   message is from Dave alone with no other participants, or if the
   batch is trivially short chatter — cheap pre-filters before spending a
   model call, similar in spirit to `isRoutineCalendarResponse` in
   `ingestEmail.ts`.
5. One Claude call over the whole ordered batch (speaker-labeled
   transcript), extraction philosophy per brief section 4 ("what is now
   different because this conversation happened?"), same strict-volume
   discipline as `ingestEmail.ts` (small caps, conservative
   role/responsibility gating, redaction).
6. For each resulting claim/pending-context item, the model must also
   return which message(s) in the batch support it (indices or message
   IDs) so provenance links go to the specific supporting
   `memory_sources` rows via `memory_claim_evidence`/
   `memory_evidence_entities` — not "the whole conversation" — per brief
   section 15.
7. Advance the family's high-water-mark to the batch's last message
   (`created_at`/`last_modified_at`) and fingerprint, regardless of
   whether anything was written (zero-output batches still advance the
   mark, same as zero-output emails in `ingestEmail.ts`).

Edited messages that were already the sole support for an existing claim
need reconciliation, not just new-claim creation: when a batch contains an
edit to a message already linked as evidence, flag the affected claim(s)
for review (a new `memory_review_items` row, `review_type:
"reconcile_edit"`) rather than silently leaving the stale claim standing.

## 8. Future-calendar contextual processing state

Treat each calendar event as its own `memory_sources` row
(`canonical_table: "calendar_events"`, `canonical_record_id: event_id`,
a new `source_type` such as `calendar_context`), created/updated lazily
when a contextual pass touches it. State lives in that row's `metadata`:

```
{
  calendar_processor_version: 1,
  content_fingerprint: "sha256:...",   // subject+start+end+attendees+organizer+cancelled
  contextual_processing_completed_at: "...",
  mode: "future"
}
```

A contextual pass (externally triggered, e.g. a daily Power Automate call
to `POST /api/memory/calendar/process-upcoming` over events in the next
N days) may create `memory_evidence` rows of `evidence_type:
"context_anchor"` linking the event to resolved person/project entities
via `memory_evidence_entities`, and it may query existing durable claims
and open `memory_pending_context` for those entities to make them
retrievable — but per brief section 7, it should typically create **zero**
`memory_claims`/`memory_pending_context` rows itself. It exposes context;
it does not assert attendance or outcomes, and it does not schedule
anything (that stays Execute's job, via `execute_touchpoints`).

## 9. Completed-calendar retrospective/reconciliation state

Same `memory_sources` row, same `metadata` bag, extended:

```
{
  ...same as section 8...,
  mode: "past",
  retrospective_status: "pending" | "initial_done" | "revisit_scheduled" | "complete",
  retrospective_initial_at: "...",
  retrospective_revisit_eligible_at: "...",   // e.g. initial_at + 3 days
  retrospective_completed_at: "...",
  reconciliation_attempts: 1
}
```

Lifecycle: `event ends` -> `pending` (eligible immediately) ->
first reconciliation pass sets `initial_done` and
`retrospective_revisit_eligible_at` -> a later externally-triggered pass
(e.g. the same daily job, filtering on `revisit_eligible_at <= now` and
`retrospective_status = 'initial_done'`) performs one bounded revisit and
sets `complete`. No indefinite reprocessing unless the event's content
fingerprint changes (section 12), which resets `retrospective_status` to
`pending` for a fresh pass (handles reschedules/cancellations discovered
after the fact).

## 10. Related-evidence retrieval order (deterministic first)

For a given calendar event, in order, stopping early once enough
high-confidence evidence is found:

1. Explicit links: `meeting_calendar_links` (already exists — created by
   `ingestArtifact.ts`'s `matchCalendarEvent`) — if a transcript/notes
   artifact is already linked to this event, start there.
2. Teams messages: `chat_id`s whose participants overlap the event's
   resolved attendees, within a narrow temporal window (e.g. event start
   - 1h to event end + 24h).
3. Follow-up email: `emails` where sender/recipient overlaps attendees
   and `message_at` falls in a similar window (reuse the entity
   resolution already in `resolveEntity.ts`).
4. Known project/entity associations: existing `memory_claims`/
   `memory_claim_entities` tied to the resolved attendee entities.
5. Subject/topic matching: reuse the word-overlap scoring already
   implemented in `matchCalendarEvent.ts` (`titleScore`) against
   candidate Teams chat topics / email subjects not caught by 2-3.
6. Semantic similarity: explicitly out of scope for the first slice —
   note as a future supplemental step, not built now.

## 11. Reprocessing / fingerprinting strategy

Uniform pattern across Teams and Calendar, matching the
`memory_ingestion_version` idiom already in `ingestEmail.ts`:
`stable_id + normalized_content_fingerprint + processor_version`, stored
in the owning row's `metadata`.

- Teams message fingerprint: hash of `body_text` (redacted) +
  `message_type`. A message is "materially edited" when this fingerprint
  changes, not merely when `last_modified_at` changes (guards against
  metadata-only sync noise, e.g. reaction updates touching
  `last_modified_at` without changing meaning — needs live-schema
  confirmation of what actually bumps `last_modified_at` vs. `etag`).
- Calendar event fingerprint: hash of `subject`, `start_time`,
  `end_time`, `organizer`, sorted `attendees`, cancellation state,
  location, and meaningful body/description (brief section 12).
  Recurrence identity/status needs live-schema confirmation (section 0)
  before it can be included precisely.

## 12. Schema migration believed necessary

Pending live-schema confirmation (section 0), the following are expected:

1. Add enum members to `memory_sources.source_type` for Teams and
   Calendar (e.g. `teams_message`, `calendar_context`) — removes the
   existing `"other"` workaround in `ingestTeamsMessage.ts`.
2. Confirm/verify a unique constraint on
   `memory_sources(canonical_table, canonical_record_id)` — existing code
   already behaves as if this holds (`.maybeSingle()` after
   `.eq().eq()`), but this should be an enforced constraint, not an
   assumption, especially once concurrent per-chat batches can run.
3. Confirm/create `public.source_sync_runs` and
   `public.complete_teams_sync` if they do not already exist in the live
   database — `AGENTS.md` describes them as already wired on the Power
   Automate side ("now calls"), which suggests they may already exist;
   this needs direct confirmation, not an assumption, since no code in
   this repo references them yet.
4. No new generic Memory processing-state table — section 5, 8, and 9
   above reuse `memory_sources.metadata` and
   `memory_source_families.metadata`, consistent with brief section 13's
   preference to extend existing metadata models first.

## 13. Cron/worker/API routes believed necessary

All externally triggered (Power Automate), no in-app scheduler, matching
the existing Mailroom pattern:

- `POST /api/memory/teams/process-sync` — driven by
  `complete_teams_sync` completion; implements section 6-7.
- `POST /api/memory/calendar/process-upcoming` — driven by a recurring
  external trigger (e.g. daily); implements section 8 over events in the
  next N days.
- `POST /api/memory/calendar/process-past` — driven by the same or a
  separate recurring external trigger; implements section 9 over events
  that ended in a bounded recent window, handling both first-pass and
  revisit-pass via the `retrospective_status` state.
- Existing `ingest-teams-test`/`backfill-teams-test` routes should be
  retired or repointed at the new batch functions once section 7 lands,
  so there is exactly one Teams ingestion code path.

## 14. Source-family usage

- **Teams**: one `memory_source_families` row per `chat_id`
  (`family_type: "teams_conversation"`) as in section 4 — this is the
  natural "shared underlying conversational unit" the brief calls for.
- **Calendar**: a completed meeting can act as a contextual family
  linking the calendar event's `memory_sources` row with any linked
  meeting artifact/transcript (`meetings.source_family_id`, already
  created by `ingestArtifact.ts`) and any Teams/email evidence discovered
  during reconciliation (section 10). Where an artifact-driven meeting
  family already exists for this event (via `meeting_calendar_links`),
  reuse it rather than creating a second family for the same meeting;
  where none exists yet (a calendar event with no uploaded artifact),
  create one lazily during the first retrospective pass so reconciled
  evidence has a home. Do not force a family for events that never
  produce any linkable evidence.

## 15. Risks / conflicts with existing architecture

- `src/lib/memory/ingestTeamsMessage.ts` and
  `src/lib/memory/backfillTeamsMessages.ts` already exist and implement
  the one-message-one-call approach the brief explicitly says to avoid.
  These need to be replaced by the batch design (section 7), not layered
  on top of — running both would double-process the same messages under
  different code paths.
- `memory_sources.source_type` has no Teams/Calendar enum members yet;
  the current Teams code silently uses `"other"`. Any migration adding
  proper enum members needs to also backfill or accept the small number
  of already-ingested test rows.
- No confirmed live schema for `source_sync_runs`/`complete_teams_sync`
  in this codebase — this is the single largest unknown blocking section
  6, and should be resolved before implementation starts (Supabase MCP
  authorization or a direct SQL check).
- No in-app cron/scheduler exists anywhere in the repo; the "bounded
  revisit" reconciliation for past calendar events (section 9) depends on
  an external caller hitting the route again on a schedule. If Power
  Automate cannot easily add a second daily trigger, the revisit pass may
  need to piggyback on the same trigger as the initial pass, just
  filtering by `retrospective_revisit_eligible_at`.
- `calendar_events`' full column set (recurrence identity, cancellation
  flag, response status, stable recurrence/ical id) is only partially
  visible from code that already queries it; fingerprinting (section 11)
  and change detection (brief section 12) need the live schema before
  being finalized.
- Mailroom must remain the sole active email-triage path (brief section
  16) — nothing here proposes touching `ingestEmail.ts`'s role or
  creating a parallel email pipeline; email stays as-is.
- Execute must remain the sole owner of scheduling/placement (brief
  section 7); the calendar contextual pass (section 8) must resist the
  temptation to create `execute_touchpoints` or similar directly — it
  only needs to make context retrievable for Execute to consume.
