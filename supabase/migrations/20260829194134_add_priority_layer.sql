-- Phase 6: CoS Prioritization Layer. Deliberately NOT reusing
-- reconciliation_runs/reconciliation_decisions: those tables' outcome
-- vocabulary and evidence_ref shape are semantically about converting
-- source evidence into operational state (Action Reconciliation), not
-- about assigning execution priority to already-trusted state. Mixing
-- the two would force priority-tier concepts into an enum that has
-- nothing to do with evidence/ownership/completion, and would blur the
-- exact separation this phase is required to preserve. The shape below
-- deliberately mirrors reconciliation_runs/reconciliation_decisions'
-- proven audit-trail pattern (trace_id linkage, counters, per-decision
-- reasoning) rather than reinventing one.

create table if not exists public.priority_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null check (trigger in ('manual_request', 'scheduled_review', 'reassessment')),
  scope text not null default 'all_active' check (scope in ('all_active', 'project', 'item')),
  scope_ref text,
  trace_id uuid references public.diagnostic_traces(id) on delete set null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  items_considered integer not null default 0,
  directives_assigned integer not null default 0,
  overrides_preserved integer not null default 0,
  overload_flags integer not null default 0,
  errors integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists priority_runs_status_idx on public.priority_runs(status, started_at desc);

alter table public.priority_runs enable row level security;

create table if not exists public.priority_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.priority_runs(id) on delete cascade,
  execution_item_id uuid references public.execution_items(id) on delete cascade,
  project_state_id uuid references public.execute_project_states(id) on delete cascade,
  outcome text not null check (outcome in (
    'assign_directive', 'reassess_directive', 'preserve_override', 'clear_directive', 'no_action', 'overload_detected'
  )),
  directive jsonb,
  previous_directive jsonb,
  signals jsonb not null default '{}',
  model_provider text,
  model_name text,
  model_version text,
  reasoning_summary text not null,
  created_at timestamptz not null default now(),
  constraint priority_decisions_target_check check (execution_item_id is not null or project_state_id is not null)
);

create index if not exists priority_decisions_run_idx on public.priority_decisions(run_id);
create index if not exists priority_decisions_item_idx on public.priority_decisions(execution_item_id) where execution_item_id is not null;
create index if not exists priority_decisions_project_idx on public.priority_decisions(project_state_id) where project_state_id is not null;
create index if not exists priority_decisions_outcome_idx on public.priority_decisions(outcome, created_at desc);

alter table public.priority_decisions enable row level security;
