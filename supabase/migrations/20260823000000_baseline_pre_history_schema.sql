-- Reconciliation baseline, added 2026-08-28.
--
-- This file is NOT a real historical migration. The live Supabase project has
-- objects (this file's tables/functions) that predate or bypass the 15
-- migrations tracked in `supabase_migrations.schema_migrations` on the
-- remote project (queried via `mcp__supabase__list_migrations`) -- most
-- likely applied by hand through the SQL editor before migration tracking
-- was adopted for this repo. There is no way to recover their original
-- incremental history, so this file reconstructs their CURRENT state as a
-- single idempotent baseline, timestamped to sort before the earliest
-- tracked migration (20260823185246).
--
-- Everything below already exists on the live project. Do not expect this
-- file to change production when applied there; it exists so a fresh
-- `supabase db reset` (or a new environment) arrives at the same schema.

-- ---------------------------------------------------------------------------
-- Mailroom domain (mailroom_runs / mailroom_conversations / mailroom_actions
-- / mailroom_feedback). No migration in the tracked history creates these.
-- ---------------------------------------------------------------------------

create table if not exists public.mailroom_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'ready_for_review', 'approved', 'executing', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  model_provider text,
  model_name text,
  messages_considered integer not null default 0,
  conversations_considered integer not null default 0,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.mailroom_conversations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.mailroom_runs(id) on delete cascade,
  conversation_id text not null,
  latest_message_id text references public.emails(outlook_message_id) on delete set null,
  item_type text not null default 'conversation'
    check (item_type in ('conversation', 'workday_system', 'calendar_system', 'meeting_request')),
  category text not null
    check (category in ('needs_you', 'fyi', 'professional_news', 'low_value', 'workday_system', 'calendar_system')),
  summary text,
  requires_attention boolean not null default false,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  suggested_reply text,
  created_at timestamptz not null default now(),
  unique (run_id, conversation_id)
);

create table if not exists public.mailroom_actions (
  id uuid primary key default gen_random_uuid(),
  mailroom_conversation_id uuid not null references public.mailroom_conversations(id) on delete cascade,
  outlook_message_id text references public.emails(outlook_message_id) on delete cascade,
  action_type text not null check (action_type in ('archive', 'needs_action', 'flag', 'accept_meeting')),
  proposed_value boolean not null default true,
  approved_value boolean,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'queued', 'executed', 'failed')),
  executed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  unique (mailroom_conversation_id, outlook_message_id, action_type)
);

create table if not exists public.mailroom_feedback (
  id uuid primary key default gen_random_uuid(),
  mailroom_conversation_id uuid not null references public.mailroom_conversations(id) on delete cascade,
  feedback_text text,
  original_category text,
  corrected_category text,
  original_flag boolean,
  corrected_flag boolean,
  original_archive boolean,
  corrected_archive boolean,
  original_needs_action boolean,
  corrected_needs_action boolean,
  created_at timestamptz not null default now()
);

create index if not exists idx_mailroom_conversations_run on public.mailroom_conversations(run_id);
create index if not exists idx_mailroom_conversations_conversation on public.mailroom_conversations(conversation_id);
create index if not exists idx_mailroom_conversations_latest_message on public.mailroom_conversations(latest_message_id);
create index if not exists idx_mailroom_conversations_category on public.mailroom_conversations(run_id, category);
create index if not exists idx_mailroom_actions_conversation on public.mailroom_actions(mailroom_conversation_id);
create index if not exists idx_mailroom_actions_message on public.mailroom_actions(outlook_message_id);
create index if not exists idx_mailroom_actions_status on public.mailroom_actions(status);
create index if not exists idx_mailroom_feedback_conversation on public.mailroom_feedback(mailroom_conversation_id);
create index if not exists idx_mailroom_feedback_created on public.mailroom_feedback(created_at desc);

alter table public.mailroom_runs enable row level security;
alter table public.mailroom_conversations enable row level security;
alter table public.mailroom_actions enable row level security;
alter table public.mailroom_feedback enable row level security;

-- Power Automate's execution trigger flow calls this directly (via the
-- Supabase REST/RPC endpoint with the service key) to close out a run after
-- it finishes processing approved mailroom_actions. Never called from
-- application code in this repo -- see src/app/api/mailroom/send-execution.
create or replace function public.complete_mailroom_run(target_run_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  update public.mailroom_runs
  set status = 'completed'
  where id = target_run_id
    and status = 'executing';
end;
$$;

-- ---------------------------------------------------------------------------
-- Source sync run-tracking infrastructure. Predates the tracked migration
-- history; the "completion signal" migrations (teams/email/calendar) only
-- add functions that write into this already-existing table.
-- ---------------------------------------------------------------------------

create table if not exists public.source_sync_runs (
  id bigint generated always as identity primary key,
  source_type text not null,
  external_run_id text not null,
  status text not null default 'completed' check (status in ('started', 'completed', 'failed')),
  completed_at timestamptz not null default now(),
  source_record_count integer not null default 0,
  source_group_count integer not null default 0,
  latest_source_at timestamptz,
  memory_status text not null default 'pending'
    check (memory_status in ('pending', 'processing', 'complete', 'failed', 'skipped')),
  memory_processor_version integer,
  memory_started_at timestamptz,
  memory_completed_at timestamptz,
  memory_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, external_run_id)
);

alter table public.source_sync_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Memory review resolution (predates all tracked Memory-review migrations
-- below; resolve_memory_review_with_correction and
-- resolve_memory_pending_review_item build on this one).
-- ---------------------------------------------------------------------------

create or replace function public.resolve_memory_review_item(target_review_item_id uuid, action text)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  review_row public.memory_review_items%rowtype;
  claim_row public.memory_claims%rowtype;
  normalized_action text := lower(trim(action));
begin
  select * into review_row from public.memory_review_items where id = target_review_item_id for update;
  if not found then raise exception 'Memory review item not found'; end if;
  if review_row.status <> 'pending' then raise exception 'Memory review item is already resolved or dismissed'; end if;
  if review_row.claim_id is null then raise exception 'This review item is not linked to a claim'; end if;

  select * into claim_row from public.memory_claims where id = review_row.claim_id for update;
  if not found then raise exception 'Linked Memory claim not found'; end if;

  case normalized_action
    when 'confirm' then
      update public.memory_claims set status='durable', evidence_strength='confirmed', confirmed_by_user=true,
        promotion_basis='user_confirmation', updated_at=now() where id=claim_row.id;
      update public.memory_review_items set status='resolved',
        resolution=jsonb_build_object('action','confirm','resolved_at',now()), resolved_at=now(), updated_at=now()
        where id=review_row.id;
    when 'outdated' then
      update public.memory_claims set status='rejected', metadata=coalesce(metadata,'{}'::jsonb) ||
        jsonb_build_object('review_resolution','outdated','reviewed_at',now()), updated_at=now() where id=claim_row.id;
      update public.memory_review_items set status='resolved',
        resolution=jsonb_build_object('action','outdated','resolved_at',now()), resolved_at=now(), updated_at=now()
        where id=review_row.id;
    when 'keep_as_evidence' then
      update public.memory_claims set status='evidence_only', metadata=coalesce(metadata,'{}'::jsonb) ||
        jsonb_build_object('review_resolution','keep_as_evidence','reviewed_at',now()), updated_at=now() where id=claim_row.id;
      update public.memory_review_items set status='resolved',
        resolution=jsonb_build_object('action','keep_as_evidence','resolved_at',now()), resolved_at=now(), updated_at=now()
        where id=review_row.id;
    when 'not_sure' then
      update public.memory_review_items set defer_until=now()+interval '7 days',
        resolution=jsonb_build_object('action','not_sure','deferred_at',now()), updated_at=now() where id=review_row.id;
    when 'dismiss' then
      update public.memory_claims set status='excluded', metadata=coalesce(metadata,'{}'::jsonb) ||
        jsonb_build_object('review_resolution','dismiss','reviewed_at',now()), updated_at=now() where id=claim_row.id;
      update public.memory_review_items set status='dismissed',
        resolution=jsonb_build_object('action','dismiss','resolved_at',now()), resolved_at=now(), updated_at=now()
        where id=review_row.id;
    else
      raise exception 'Invalid action. Use confirm, outdated, keep_as_evidence, not_sure, or dismiss.';
  end case;

  return jsonb_build_object('review_item_id',review_row.id,'claim_id',claim_row.id,'action',normalized_action);
end;
$$;

-- Used by the inbox-snapshot email sync path to mark stale inbox copies as
-- no longer in the inbox once a fresh snapshot has landed.
create or replace function public.finalize_inbox_snapshot(current_snapshot_id text)
returns integer
language plpgsql
security definer
as $$
declare
  updated_count integer;
begin
  update public.emails
  set is_in_inbox = false
  where is_in_inbox = true
    and (
      inbox_snapshot_id is null
      or inbox_snapshot_id <> current_snapshot_id
    );

  get diagnostics updated_count = row_count;

  return updated_count;
end;
$$;
