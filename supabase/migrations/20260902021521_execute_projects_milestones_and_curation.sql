-- Execute as a first-class work-management layer.
--
-- Three things this migration deliberately does NOT do:
--   * It does not create a new `projects` table. Projects already exist as
--     execute_project_states (currently 0 rows); making that row the
--     first-class Project -- rather than a thin status overlay on a Memory
--     entity -- is an extension, not a parallel schema. The table keeps its
--     name: every FK in the codebase is `project_state_id`, and renaming a
--     concept purely for aesthetics is what the brief rules out.
--   * It does not touch calendar_events. Outlook owns those fields; Proxy's
--     enrichment lives in execute_touchpoints, which already exists for this
--     purpose (project + calendar event + desired state).
--   * It does not remove or repurpose Work Block infrastructure.
--
-- Everything here is additive and re-runnable.

-- ---------------------------------------------------------------------------
-- 1. PROJECTS: first-class objects, not tags on tasks
-- ---------------------------------------------------------------------------

-- A Project no longer REQUIRES a Memory project entity. The link stays
-- (Memory is where a project is first recognized as a thing that exists), but
-- Execute can now own a project outright -- created in the app or in Notion --
-- without first manufacturing a Memory entity for it.
alter table public.execute_project_states
  alter column memory_project_entity_id drop not null;

alter table public.execute_project_states
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists desired_outcome text,
  add column if not exists why_it_matters text,
  add column if not exists target_date date,
  add column if not exists owner_entity_id uuid references public.memory_entities(id) on delete set null,
  add column if not exists created_by text not null default 'proxy';

-- Title is Execute-owned display truth. Linked projects get it seeded from
-- the Memory entity; readers fall back to the entity name when it is null, so
-- neither side silently wins.
update public.execute_project_states as p
set title = e.canonical_name
from public.memory_entities as e
where p.title is null and p.memory_project_entity_id = e.id;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'execute_project_states_identity_check'
  ) then
    alter table public.execute_project_states
      add constraint execute_project_states_identity_check
      check (title is not null or memory_project_entity_id is not null);
  end if;
end $$;

comment on table public.execute_project_states is
  'An Execute Project: the major container of work. Optionally linked to a Memory project entity (provenance), but no longer dependent on one.';
comment on column public.execute_project_states.title is
  'Execute-owned project name. Readers use coalesce(title, memory entity canonical_name).';
comment on column public.execute_project_states.why_it_matters is
  'Strategic justification, human-authored. Distinct from priority_directive.why, which a future Chief of Staff writes and rewrites.';
comment on column public.execute_project_states.next_plateau is
  'The nearest required plateau, denormalized for quick reading. Durable per-touchpoint plateaus live in execute_touchpoints.desired_state.';

-- ---------------------------------------------------------------------------
-- 2. MILESTONES: durable named accomplishments within a Project
-- ---------------------------------------------------------------------------

-- A MILESTONE is a durable accomplishment in a project's progression.
-- A PLATEAU (execute_touchpoints.desired_state) is the state the project must
-- have reached by a particular touchpoint -- usually a meeting. A plateau MAY
-- point at a milestone (touchpoints.milestone_id) but usually will not:
-- "ready enough for faculty discussion on Thursday" is not an accomplishment.
create table if not exists public.execute_milestones (
  id uuid primary key default gen_random_uuid(),
  project_state_id uuid not null references public.execute_project_states(id) on delete cascade,
  title text not null,
  description text,
  target_date date,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'achieved', 'abandoned')),
  achieved_at timestamptz,
  position smallint not null default 0,
  created_by text not null default 'proxy',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists execute_milestones_project_idx
  on public.execute_milestones(project_state_id, target_date);

alter table public.execute_milestones enable row level security;

comment on table public.execute_milestones is
  'Durable named accomplishments in a Project''s progression. A Project may have many, over time.';

-- ---------------------------------------------------------------------------
-- 3. TOUCHPOINTS: Proxy-owned enrichment of a canonical Outlook event
-- ---------------------------------------------------------------------------

-- Outlook owns subject/start/end/organizer/attendees/recurrence/identity on
-- calendar_events. Nothing in Notion may write those. This table is where
-- Proxy-owned meaning about the same meeting lives, keyed by the Outlook event
-- id -- which is why the enrichment is a related row, not extra columns on
-- calendar_events.
alter table public.execute_touchpoints
  alter column project_state_id drop not null,
  alter column desired_state drop not null;

alter table public.execute_touchpoints
  add column if not exists milestone_id uuid references public.execute_milestones(id) on delete set null,
  add column if not exists preparation_notes text;

-- (project_state_id, calendar_event_id) is already unique, but NULLs compare
-- distinct in Postgres, so a meeting enriched with notes and no project could
-- accumulate duplicate rows. One project-less enrichment row per event.
create unique index if not exists execute_touchpoints_event_without_project_idx
  on public.execute_touchpoints(calendar_event_id)
  where project_state_id is null;

comment on table public.execute_touchpoints is
  'Proxy-owned enrichment of a canonical Outlook calendar event: which Project it serves, which Milestone, and the PLATEAU the project must have reached by then. Never writes back to calendar_events.';
comment on column public.execute_touchpoints.desired_state is
  'The PLATEAU: the state this project must have reached by this touchpoint.';
comment on column public.execute_touchpoints.created_by is
  'Who authored this enrichment. See the follow-up migration that widens the allowed values to include notion and proxy_ui.';

-- ---------------------------------------------------------------------------
-- 4. EXECUTION ITEMS: provenance, curation, and manual planning
-- ---------------------------------------------------------------------------

alter table public.execution_items
  add column if not exists source_system text,
  add column if not exists source_ref text,
  add column if not exists source_withdrawn_at timestamptz,
  add column if not exists curated boolean not null default false,
  add column if not exists why_surfaced text,
  add column if not exists why_suppressed text,
  add column if not exists last_assessed_at timestamptz,
  add column if not exists planned_at timestamptz;

-- Priority tier is DERIVED from the CoS directive, never independently
-- writable: a generated column cannot drift from priority_directive, so
-- "what tier is this?" stays queryable and indexable without creating a
-- second place where priority can be set. A future Chief of Staff remains
-- the only writer of priority; Execute only reads it.
alter table public.execution_items
  add column if not exists priority_tier text
  generated always as (priority_directive->>'tier') stored;

-- The idempotency key for source-driven creation. Only sources that produce
-- exactly ONE item per source record set it (Mailroom: one conversation ->
-- one item). Artifact/meeting extraction produces many items per source, so
-- those keep source_system for provenance and leave source_ref null -- their
-- pointer is source_artifact_id / source_meeting_id, and their per-evidence
-- provenance is execution_evidence.
create unique index if not exists execution_items_source_identity_idx
  on public.execution_items(source_system, source_ref)
  where source_ref is not null;

create index if not exists execution_items_curated_idx
  on public.execution_items(curated, status);

update public.execution_items
set source_system = 'artifact'
where source_system is null and source_artifact_id is not null;

update public.execution_items
set source_system = 'meeting'
where source_system is null and source_meeting_id is not null;

update public.execution_items
set source_system = 'manual'
where source_system is null and extraction_basis = 'execute_manual';

update public.execution_items
set source_system = 'reconciliation'
where source_system is null;

comment on column public.execution_items.source_system is
  'Which system produced this item: mailroom | artifact | meeting | manual | reconciliation | notion.';
comment on column public.execution_items.source_ref is
  'Stable idempotency key within source_system (e.g. a Mailroom conversation_id). Null when the source does not map one-to-one onto items.';
comment on column public.execution_items.source_withdrawn_at is
  'When the source stopped qualifying (e.g. the email is no longer classified Needs Attention). Recorded, never deleted -- an explicit state change, not destruction.';
comment on column public.execution_items.curated is
  'Does Proxy currently believe this deserves Dave''s attention? Recomputed by curationPolicy.ts; why_surfaced/why_suppressed always explain the current value.';
comment on column public.execution_items.last_assessed_at is
  'When the curation DECISION last changed -- not every sweep. A stable value keeps the Notion projection quiet instead of re-pushing every row on every pass.';
comment on column public.execution_items.planned_at is
  'Dave''s MANUAL planning date, moved by hand in Notion. Deliberately not autonomous scheduling, and distinct from timing_at (the due/target date the world imposes).';
comment on column public.execution_items.priority_tier is
  'Generated from priority_directive->>''tier''. Read-only by construction.';
