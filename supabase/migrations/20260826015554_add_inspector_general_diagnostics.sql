-- Inspector General Phase 1: shared diagnostic trace/event/issue schema.
-- Additive only. No existing tables are modified.

create table if not exists public.diagnostic_traces (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  source_type text,
  source_id text,
  object_type text,
  object_id text,
  summary text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.diagnostic_events (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references public.diagnostic_traces(id) on delete cascade,
  parent_event_id uuid references public.diagnostic_events(id) on delete set null,
  module text not null,
  stage text not null,
  event_type text not null,
  status text not null check (status in ('success', 'failure', 'warning', 'pending')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'error', 'critical')),
  occurred_at timestamptz not null default now(),
  duration_ms integer,
  source_type text,
  source_id text,
  object_type text,
  object_id text,
  human_summary text not null,
  human_detail text,
  decision_type text,
  decision_reason text,
  technical_code text,
  technical_detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.diagnostic_issues (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid references public.diagnostic_traces(id) on delete set null,
  event_id uuid references public.diagnostic_events(id) on delete set null,
  issue_type text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'error', 'critical')),
  status text not null default 'open' check (status in ('open', 'retrying', 'resolved_automatically', 'resolved_manually', 'ignored')),
  human_summary text not null,
  human_detail text,
  object_type text,
  object_id text,
  source_type text,
  source_id text,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  attempt_count integer not null default 1,
  retryable boolean not null default false,
  technical_detail text,
  resolution_note text,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists diagnostic_events_trace_id_idx on public.diagnostic_events(trace_id);
create index if not exists diagnostic_events_object_idx on public.diagnostic_events(object_type, object_id);
create index if not exists diagnostic_traces_started_at_idx on public.diagnostic_traces(started_at desc);
create index if not exists diagnostic_traces_object_idx on public.diagnostic_traces(object_type, object_id);
create index if not exists diagnostic_issues_status_idx on public.diagnostic_issues(status);
create index if not exists diagnostic_issues_source_idx on public.diagnostic_issues(source_type, source_id);

-- RLS enabled with no policies, matching every other Proxy table: the app
-- talks to Supabase exclusively via the service-role key (which bypasses
-- RLS), so this fully locks out the anon/authenticated roles by default.
alter table public.diagnostic_traces enable row level security;
alter table public.diagnostic_events enable row level security;
alter table public.diagnostic_issues enable row level security;
