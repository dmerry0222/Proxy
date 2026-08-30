-- Reconstructed 2026-08-28 from the live schema (information_schema.columns,
-- pg_constraint, pg_indexes). Foreign-key covering indexes and the
-- calendar-run-reconciliation additions are intentionally left out of this
-- file -- they belong to the two migrations that follow
-- (add_execute_foreign_key_indexes, add_calendar_run_reconciliation) per the
-- tracked remote history.

create table if not exists public.execute_project_states (
  id uuid primary key default gen_random_uuid(),
  memory_project_entity_id uuid not null unique
    references public.memory_entities(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'operationally_complete', 'inactive')),
  next_plateau text,
  priority_directive jsonb,
  activated_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.execution_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  status text not null default 'candidate'
    check (status in ('candidate', 'active', 'completed', 'cancelled', 'deferred')),
  assignee_entity_id uuid references public.memory_entities(id) on delete set null,
  requester_entity_id uuid references public.memory_entities(id) on delete set null,
  timing_at timestamptz,
  source_meeting_id uuid references public.meetings(id) on delete set null,
  source_artifact_id uuid references public.artifacts(id) on delete set null,
  confidence numeric check (confidence >= 0 and confidence <= 1),
  extraction_basis text,
  confirmed_by_user boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_state_id uuid references public.execute_project_states(id) on delete set null,
  responsibility text not null default 'mine' check (responsibility in ('mine', 'external')),
  effort_minutes integer check (effort_minutes is null or effort_minutes > 0),
  timing_kind text check (timing_kind is null or timing_kind in ('must', 'target')),
  critical_rank smallint check (critical_rank is null or (critical_rank >= 1 and critical_rank <= 3)),
  waiting_since timestamptz,
  expected_at timestamptz,
  related_person_entity_id uuid references public.memory_entities(id) on delete set null,
  obligation_context text,
  priority_directive jsonb,
  deferred_until timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint execution_items_timing_check
    check ((timing_kind is null and timing_at is null) or (timing_kind is not null and timing_at is not null)),
  constraint execution_items_waiting_check
    check (responsibility = 'external' or waiting_since is null)
);

create unique index if not exists execution_items_project_critical_rank_idx
  on public.execution_items(project_state_id, critical_rank)
  where critical_rank is not null and status = 'active';
create index if not exists execution_items_project_status_idx on public.execution_items(project_state_id, status);
create index if not exists execution_items_status_timing_idx on public.execution_items(status, timing_at);

create table if not exists public.execute_work_blocks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'committed', 'completed', 'partial', 'missed', 'cancelled')),
  planned_start timestamptz not null,
  planned_end timestamptz not null,
  calendar_event_id text unique references public.calendar_events(event_id) on delete set null,
  provider_request_id text unique,
  checklist jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),
  completion_note text,
  movement_history jsonb not null default '[]'::jsonb check (jsonb_typeof(movement_history) = 'array'),
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint execute_work_blocks_check check (planned_end > planned_start)
);

create index if not exists execute_work_blocks_horizon_idx
  on public.execute_work_blocks(planned_start, planned_end)
  where status <> 'cancelled';

create table if not exists public.execute_work_block_items (
  work_block_id uuid not null references public.execute_work_blocks(id) on delete cascade,
  execution_item_id uuid not null references public.execution_items(id) on delete cascade,
  allocated_minutes integer check (allocated_minutes is null or allocated_minutes > 0),
  position smallint not null default 0 check (position >= 0),
  primary key (work_block_id, execution_item_id)
);

create table if not exists public.execute_calendar_outbox (
  id uuid primary key default gen_random_uuid(),
  work_block_id uuid not null references public.execute_work_blocks(id) on delete cascade,
  operation text not null check (operation in ('create', 'update', 'cancel')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'reconciled', 'failed', 'cancelled')),
  idempotency_key text not null unique,
  payload jsonb not null,
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists execute_calendar_outbox_pending_idx
  on public.execute_calendar_outbox(status, created_at)
  where status in ('pending', 'failed');

create table if not exists public.execute_touchpoints (
  id uuid primary key default gen_random_uuid(),
  project_state_id uuid not null references public.execute_project_states(id) on delete cascade,
  calendar_event_id text not null references public.calendar_events(event_id) on delete cascade,
  desired_state text not null,
  created_by text not null default 'ai' check (created_by in ('ai', 'user', 'system')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_state_id, calendar_event_id)
);

create table if not exists public.execute_attention_items (
  id uuid primary key default gen_random_uuid(),
  project_state_id uuid references public.execute_project_states(id) on delete cascade,
  execution_item_id uuid references public.execution_items(id) on delete cascade,
  work_block_id uuid references public.execute_work_blocks(id) on delete cascade,
  touchpoint_id uuid references public.execute_touchpoints(id) on delete cascade,
  kind text not null,
  urgency text not null default 'weekly_review'
    check (urgency in ('interrupt_now', 'daily_review', 'weekly_review')),
  audience text not null default 'dave' check (audience in ('dave', 'cos', 'both')),
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed', 'deferred')),
  title text not null,
  detail text,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  defer_until timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists execute_attention_items_pending_dedupe_idx
  on public.execute_attention_items(dedupe_key)
  where dedupe_key is not null and status = 'pending';
create index if not exists execute_attention_items_queue_idx
  on public.execute_attention_items(status, urgency, defer_until, created_at);

create table if not exists public.execute_capacity_windows (
  id uuid primary key default gen_random_uuid(),
  start_at timestamptz not null,
  end_at timestamptz not null,
  label text,
  source_command text,
  status text not null default 'available'
    check (status in ('available', 'consumed', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint execute_capacity_windows_check check (end_at > start_at)
);

create index if not exists execute_capacity_windows_horizon_idx
  on public.execute_capacity_windows(start_at, end_at)
  where status = 'available';

create table if not exists public.execute_review_sessions (
  id uuid primary key default gen_random_uuid(),
  review_type text not null check (review_type in ('daily', 'weekly')),
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  horizon_start date not null,
  horizon_end date not null,
  attention_item_ids uuid[] not null default '{}',
  current_index integer not null default 0 check (current_index >= 0),
  responses jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint execute_review_sessions_check check (horizon_end >= horizon_start)
);

create unique index if not exists execute_review_sessions_one_active_idx
  on public.execute_review_sessions(review_type)
  where status = 'active';

alter table public.execute_project_states enable row level security;
alter table public.execution_items enable row level security;
alter table public.execute_work_blocks enable row level security;
alter table public.execute_work_block_items enable row level security;
alter table public.execute_calendar_outbox enable row level security;
alter table public.execute_touchpoints enable row level security;
alter table public.execute_attention_items enable row level security;
alter table public.execute_capacity_windows enable row level security;
alter table public.execute_review_sessions enable row level security;
