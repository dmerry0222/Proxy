-- Reconstructed 2026-08-28 from the live function definition.

create or replace function public.complete_teams_sync(p_run_guid text, p_completed_at timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run_guid text := nullif(btrim(p_run_guid), '');
  v_message_count integer := 0;
  v_chat_count integer := 0;
  v_latest_source_at timestamptz;
  v_run public.source_sync_runs;
begin
  if v_run_guid is null then
    raise exception 'run_guid is required';
  end if;

  select
    count(*)::integer,
    count(distinct chat_id)::integer,
    max(coalesce(last_modified_at, created_at))
  into
    v_message_count,
    v_chat_count,
    v_latest_source_at
  from public.teams_messages
  where run_guid = v_run_guid;

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
    'teams',
    v_run_guid,
    'completed',
    coalesce(p_completed_at, now()),
    v_message_count,
    v_chat_count,
    v_latest_source_at,
    'pending',
    jsonb_build_object(
      'signal_type', 'sync_complete',
      'record_unit', 'message',
      'group_unit', 'chat'
    )
  )
  on conflict (source_type, external_run_id)
  do update set
    status = 'completed',
    completed_at = excluded.completed_at,
    source_record_count = excluded.source_record_count,
    source_group_count = excluded.source_group_count,
    latest_source_at = excluded.latest_source_at,
    metadata = public.source_sync_runs.metadata || excluded.metadata,
    updated_at = now()
  returning * into v_run;

  return jsonb_build_object(
    'success', true,
    'source', 'teams',
    'run_guid', v_run.external_run_id,
    'sync_run_id', v_run.id,
    'completed_at', v_run.completed_at,
    'messages_in_run', v_run.source_record_count,
    'chats_in_run', v_run.source_group_count,
    'latest_source_at', v_run.latest_source_at,
    'memory_status', v_run.memory_status
  );
end;
$$;

revoke execute on function public.complete_teams_sync(text, timestamptz) from public;
grant execute on function public.complete_teams_sync(text, timestamptz) to service_role;
