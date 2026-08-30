-- Reconstructed 2026-08-28 from the live function definition.

create or replace function public.complete_email_sync(p_run_guid text, p_scope text default 'all', p_completed_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run_guid text := nullif(btrim(p_run_guid), '');
  v_scope text := lower(coalesce(nullif(btrim(p_scope), ''), 'all'));
  v_record_count integer := 0;
  v_conversation_count integer := 0;
  v_latest_source_at timestamptz;
  v_run public.source_sync_runs;
begin
  if v_run_guid is null then
    raise exception 'run_guid is required';
  end if;

  if v_scope not in ('all','inbox','sent','archive') then
    raise exception 'scope must be one of: all, inbox, sent, archive';
  end if;

  select
    count(*)::integer,
    count(distinct conversation_id)::integer,
    max(coalesce(message_at, received_at, updated_at))
  into
    v_record_count,
    v_conversation_count,
    v_latest_source_at
  from public.emails e
  where
    case v_scope
      when 'inbox' then e.is_in_inbox = true
      when 'sent' then lower(coalesce(e.direction,'')) = 'outgoing' or lower(coalesce(e.folder,'')) = 'sent items'
      when 'archive' then lower(coalesce(e.folder,'')) in ('archive','archived')
      else true
    end;

  insert into public.source_sync_runs (
    source_type,
    external_run_id,
    status,
    completed_at,
    source_record_count,
    source_group_count,
    latest_source_at,
    memory_status,
    metadata
  )
  values (
    'email',
    v_run_guid,
    'completed',
    coalesce(p_completed_at, now()),
    v_record_count,
    v_conversation_count,
    v_latest_source_at,
    'pending',
    jsonb_build_object(
      'signal_type', 'sync_complete',
      'scope', v_scope,
      'record_unit', 'message',
      'group_unit', 'conversation',
      'selection_note', 'Email rows are not batch-keyed by run_guid; processor must use existing Memory idempotency/provenance to identify new or changed messages.'
    )
  )
  on conflict (source_type, external_run_id)
  do update set
    status = 'completed',
    completed_at = excluded.completed_at,
    source_record_count = excluded.source_record_count,
    source_group_count = excluded.source_group_count,
    latest_source_at = excluded.latest_source_at,
    memory_status = case
      when public.source_sync_runs.memory_status in ('complete','failed','skipped') then 'pending'
      else public.source_sync_runs.memory_status
    end,
    memory_processor_version = null,
    memory_started_at = null,
    memory_completed_at = null,
    memory_error = null,
    metadata = public.source_sync_runs.metadata || excluded.metadata,
    updated_at = now()
  returning * into v_run;

  return jsonb_build_object(
    'success', true,
    'source', 'email',
    'scope', v_scope,
    'run_guid', v_run.external_run_id,
    'sync_run_id', v_run.id,
    'completed_at', v_run.completed_at,
    'messages_visible', v_run.source_record_count,
    'conversations_visible', v_run.source_group_count,
    'latest_source_at', v_run.latest_source_at,
    'memory_status', v_run.memory_status
  );
end;
$$;

revoke execute on function public.complete_email_sync(text, text, timestamptz) from public;
grant execute on function public.complete_email_sync(text, text, timestamptz) to service_role;
