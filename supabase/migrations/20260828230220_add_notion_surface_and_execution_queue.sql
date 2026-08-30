-- Notion Surface Adapter (Brief Part 1) + durable execution command queue
-- (Brief Part 7). Additive only; no existing tables are touched.
--
-- surface_objects maps a canonical Proxy object (Mailroom conversation,
-- Execute project/item/work block, calendar event, ...) to its projection
-- in an external surface (Notion today; surface_type leaves room for
-- others later without a schema change). Proxy always owns the mapping:
-- an external object with no row here is not recognized as belonging to
-- any Proxy object.
--
-- execution_commands is the durable queue between a human submission
-- (Notion webhook or Mailroom "approve") and Power Automate. A Notion
-- button press enqueues a command and returns immediately; a worker drains
-- the queue and calls Power Automate, updating status as results come
-- back. This decouples UI responsiveness from execution latency (Part 7).

create table if not exists public.surface_objects (
  id uuid primary key default gen_random_uuid(),
  surface_type text not null default 'notion' check (surface_type in ('notion')),
  object_type text not null,
  proxy_object_id text not null,
  external_object_id text,
  last_pushed_at timestamptz,
  last_pulled_at timestamptz,
  last_external_updated_at timestamptz,
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'stale', 'error')),
  sync_error text,
  canonical_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (surface_type, object_type, proxy_object_id)
);

create unique index if not exists surface_objects_external_idx
  on public.surface_objects(surface_type, external_object_id)
  where external_object_id is not null;

create index if not exists surface_objects_sync_status_idx
  on public.surface_objects(sync_status)
  where sync_status in ('pending', 'stale', 'error');

create table if not exists public.execution_commands (
  id uuid primary key default gen_random_uuid(),
  domain text not null check (domain in ('mailroom', 'execute')),
  object_type text not null,
  object_id text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed', 'retrying')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  idempotency_key text not null unique,
  notion_page_id text,
  trace_id uuid references public.diagnostic_traces(id) on delete set null,
  external_execution_id text,
  last_error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists execution_commands_queue_idx
  on public.execution_commands(status, created_at)
  where status in ('queued', 'retrying');

create index if not exists execution_commands_object_idx
  on public.execution_commands(domain, object_type, object_id);

-- RLS enabled with no policies, matching every other Proxy table: the app
-- talks to Supabase exclusively via the service-role key (which bypasses
-- RLS), so this fully locks out the anon/authenticated roles by default.
alter table public.surface_objects enable row level security;
alter table public.execution_commands enable row level security;
