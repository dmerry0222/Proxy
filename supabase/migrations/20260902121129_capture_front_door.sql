-- Capture: the durable, authenticated front door for intentional user input.
--
-- WHY A NEW TABLE, having looked at the alternatives first:
--
--   * `artifacts` is file-shaped. original_filename, mime_type,
--     storage_bucket, storage_path and content_hash are all NOT NULL, and the
--     row only makes sense alongside a Supabase Storage object and a
--     document_sections parse. A one-line quick task from Drafts has no file,
--     so routing it there would mean inventing a filename and uploading a blob
--     per capture -- ceremony that exists to serve a pipeline this input does
--     not enter.
--   * `memory_sources` is Memory's provenance spine, not an intake queue. It
--     has no processing status, no error column, and no dedup identity. Every
--     capture landing there would assert "this is a Memory source" before
--     anything had decided it was one.
--   * `ingestion_jobs` is artifact-scoped (artifact_id NOT NULL).
--
-- Both of those tables remain the right DESTINATIONS for what a capture
-- becomes; see the provenance contract at the bottom of this file.

create table if not exists public.captures (
  id uuid primary key default gen_random_uuid(),

  -- Small controlled vocabulary: the ways a human intentionally hands
  -- something to Proxy. Widening this is a migration, on purpose -- an
  -- unrecognized source is far more likely to be a typo in a Shortcut than a
  -- new integration, and a typo that silently becomes a new source value
  -- makes every later "where do my captures come from?" answer wrong.
  source text not null
    check (source in ('drafts', 'ios_shortcut', 'proxy_ui', 'share_sheet', 'nfc', 'other')),

  -- Deliberately NOT an enum and NOT constrained. Capture types are a
  -- vocabulary Dave is still discovering; Proxy recognizes some (quick_add,
  -- quick_add_task, long_ramble, note, idea, log) but an unknown value is
  -- recorded as-is rather than rejected. Rejecting it would lose the capture
  -- to protect a taxonomy, which is exactly backwards at the front door.
  capture_type text not null,

  -- The whole point. Never overwritten, never trimmed away by downstream
  -- processing, retained after a capture has produced its outputs.
  content text not null check (length(btrim(content)) > 0),

  -- The client's own identifier (a Drafts UUID, a Shortcut run id). Optional:
  -- a capture with nothing stable to key on is still a valid capture.
  source_external_id text,

  -- Two clocks, kept apart on purpose. captured_at is the client's (a phone
  -- offline in a basement can capture at 09:00 and deliver at 11:00);
  -- received_at is Proxy's and is never supplied by the caller.
  captured_at timestamptz,
  received_at timestamptz not null default now(),

  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'processed', 'failed')),
  processing_error text,
  processed_at timestamptz,

  -- Set only if and when a capture is promoted into Memory. Nullable because
  -- most captures will never be: the front door does not presume the room.
  memory_source_id uuid references public.memory_sources(id) on delete set null,

  -- The Inspector General trace opened for this capture, so the record points
  -- at its own observability rather than requiring a reverse lookup.
  diagnostic_trace_id uuid,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Deduplication: (source, source_external_id). A Drafts action that fires
-- twice, or a Shortcut retried on a flaky connection, collapses onto the same
-- capture instead of creating a second one.
--
-- Note what is deliberately NOT deduplicated: identical content with no
-- external id. "Call Alicia" captured twice on purpose is two captures, and a
-- content-hash rule at this layer would silently discard the second one.
create unique index if not exists captures_source_external_id_idx
  on public.captures (source, source_external_id)
  where source_external_id is not null;

create index if not exists captures_status_idx
  on public.captures (processing_status, received_at desc);

create index if not exists captures_received_idx
  on public.captures (received_at desc);

alter table public.captures enable row level security;

comment on table public.captures is
  'The durable front door for intentional user captures (Drafts, Shortcuts, Proxy UI, Share Sheet, NFC). One row per capture, preserved permanently, including after it has produced downstream objects.';
comment on column public.captures.capture_type is
  'Extensible free string, not an enum. Recognized: quick_add, quick_add_task, long_ramble, note, idea, log. Unknown values are accepted and recorded.';
comment on column public.captures.source_external_id is
  'The client''s own id for this capture (e.g. a Drafts UUID). Unique per source; this is what makes a retry idempotent.';
comment on column public.captures.captured_at is
  'When the human captured it, per the client clock. May precede received_at by a long way, and may be absent.';
comment on column public.captures.received_at is
  'When Proxy accepted it. Server-assigned; never taken from the payload.';
comment on column public.captures.processing_status is
  'received -> processing -> processed | failed. A capture is durable at "received"; no processor is required for the record to be complete.';
comment on column public.captures.memory_source_id is
  'Set only if this capture is later promoted into Memory, as a user_statement source pointing back here via canonical_table/canonical_record_id.';

-- ---------------------------------------------------------------------------
-- PROVENANCE CONTRACT for what a capture becomes
-- ---------------------------------------------------------------------------
--
-- A capture may produce several outputs. Each uses the pointer mechanism that
-- already exists for that destination, so there is one way to ask "where did
-- this come from" per object type, not a new one:
--
--   execution item   execution_items.source_system = 'capture'
--                    execution_items.source_ref    = captures.id
--                    (the unique index on that pair keeps one item per capture)
--
--   evidence         execution_evidence.source_type    = 'capture'
--                    execution_evidence.source_locator = {"capture_id": "..."}
--
--   Memory           memory_sources.source_type       = 'user_statement'
--                    memory_sources.canonical_table    = 'captures'
--                    memory_sources.canonical_record_id = captures.id
--                    captures.memory_source_id          = that source
--
-- Only the evidence source_type needs widening; the other two already accept
-- these values.

alter table public.execution_evidence
  drop constraint if exists execution_evidence_source_type_check;

alter table public.execution_evidence
  add constraint execution_evidence_source_type_check
  check (source_type = any (array[
    'document_section', 'email', 'teams_message', 'calendar_event',
    'memory_evidence', 'user_action', 'capture'
  ]));
