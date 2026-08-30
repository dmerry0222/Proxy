-- Action Reconciliation Layer, Phase 1 (schema foundation only -- no
-- source integration changes in this migration; extractMeetingKnowledge.ts
-- and interpretGenericArtifact.ts keep writing task_evidence unchanged
-- until Phase 2's refactor cuts them over to execution_evidence).

-- ---------------------------------------------------------------------------
-- execution_evidence: generalizes task_evidence beyond document_sections to
-- any source type the reconciler can draw evidence from. task_evidence is
-- left in place (still the only thing the two current writers touch) and
-- its existing rows are backfilled here for continuity once Phase 2 reads
-- from the new table.
-- ---------------------------------------------------------------------------

create table if not exists public.execution_evidence (
  id uuid primary key default gen_random_uuid(),
  execution_item_id uuid not null references public.execution_items(id) on delete cascade,
  source_type text not null
    check (source_type in ('document_section', 'email', 'teams_message', 'calendar_event', 'memory_evidence', 'user_action')),
  -- Shape depends on source_type: {section_id} | {outlook_message_id} | {teams_message_id}
  -- | {calendar_event_id, run_guid} | {memory_evidence_id} | {actor, action}.
  source_locator jsonb not null,
  excerpt text,
  relationship text not null default 'supports_creation'
    check (relationship in (
      'supports_creation', 'supports_ownership', 'supports_timing', 'supports_external_owner',
      'supports_completion', 'supports_cancellation', 'supports_project', 'contradicts', 'supersedes'
    )),
  occurred_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (execution_item_id, source_type, source_locator, relationship)
);

create index if not exists execution_evidence_item_idx on public.execution_evidence(execution_item_id);
create index if not exists execution_evidence_source_idx on public.execution_evidence(source_type, source_locator);

alter table public.execution_evidence enable row level security;

-- Backfill existing task_evidence rows so execution_evidence is a complete
-- picture from day one, even though task_evidence remains the live write
-- path until Phase 2.
insert into public.execution_evidence (execution_item_id, source_type, source_locator, excerpt, relationship, created_at)
select
  te.task_id,
  'document_section',
  jsonb_build_object('section_id', te.section_id),
  te.excerpt,
  'supports_creation',
  te.created_at
from public.task_evidence te
on conflict (execution_item_id, source_type, source_locator, relationship) do nothing;

-- ---------------------------------------------------------------------------
-- Reconciliation audit trail. Deliberately separate from
-- diagnostic_traces/diagnostic_events (those are generic pipeline
-- observability; these carry match-basis/ownership-basis/confidence/
-- user-outcome semantics specific to reconciliation) but FK-linked to a
-- diagnostic_traces row so Inspector General can jump between them.
-- ---------------------------------------------------------------------------

create table if not exists public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('forward', 'backfill', 'manual_replay')),
  source_type text not null,
  trace_id uuid references public.diagnostic_traces(id) on delete set null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- backfill only
  horizon_start timestamptz,
  horizon_end timestamptz,
  cursor jsonb not null default '{}'::jsonb,
  evidence_considered integer not null default 0,
  items_created integer not null default 0,
  items_matched integer not null default 0,
  items_ignored integer not null default 0,
  errors integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_runs_status_idx on public.reconciliation_runs(status, started_at desc);
create index if not exists reconciliation_runs_source_idx on public.reconciliation_runs(source_type, started_at desc);

alter table public.reconciliation_runs enable row level security;

create table if not exists public.reconciliation_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.reconciliation_runs(id) on delete cascade,
  -- Points at an execution_evidence row once one exists, or carries a raw
  -- envelope reference for decisions that produced no evidence row (e.g. a
  -- deliberate no_action).
  evidence_ref jsonb not null default '{}'::jsonb,
  outcome text not null check (outcome in (
    'create_dave_item', 'create_external_item', 'attach_evidence', 'update_timing',
    'propose_completion', 'complete', 'propose_cancellation', 'cancel',
    'associate_project', 'nominate_project', 'pending_context_only', 'no_action', 'ambiguous_review'
  )),
  matched_execution_item_id uuid references public.execution_items(id) on delete set null,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  ownership_basis text,
  match_basis text,
  model_provider text,
  model_name text,
  model_version text,
  automatic boolean not null default false,
  user_outcome text check (user_outcome is null or user_outcome in ('pending', 'confirmed', 'corrected', 'rejected')),
  reasoning_summary text,
  created_at timestamptz not null default now()
);

create index if not exists reconciliation_decisions_run_idx on public.reconciliation_decisions(run_id);
create index if not exists reconciliation_decisions_item_idx
  on public.reconciliation_decisions(matched_execution_item_id) where matched_execution_item_id is not null;
create index if not exists reconciliation_decisions_outcome_idx on public.reconciliation_decisions(outcome, created_at desc);

alter table public.reconciliation_decisions enable row level security;

-- ---------------------------------------------------------------------------
-- Link an execution item back to the Memory pending-context row it
-- resolved from, where applicable (Brief Part 13) -- lets the reconciler
-- avoid surfacing two independent reminders for the same underlying thing.
-- ---------------------------------------------------------------------------

alter table public.execution_items
  add column if not exists pending_context_id uuid references public.memory_pending_context(id) on delete set null;

create index if not exists execution_items_pending_context_idx
  on public.execution_items(pending_context_id) where pending_context_id is not null;
