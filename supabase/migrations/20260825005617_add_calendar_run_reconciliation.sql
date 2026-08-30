-- Reconstructed 2026-08-28 from the live function definitions and
-- calendar_events.run_guid column/index.

alter table public.calendar_events
  add column if not exists run_guid uuid;

create index if not exists calendar_events_run_guid_idx on public.calendar_events(run_guid);

-- Deletes any calendar_events in [window_start, window_end) that were NOT
-- part of the given run_guid -- i.e. events Outlook no longer reports for
-- that window. Returns the number of rows deleted.
create or replace function public.reconcile_calendar(run_guid uuid, window_start timestamptz, window_end timestamptz)
returns bigint
language sql
set search_path to ''
as $$
  with deleted as (
    delete from public.calendar_events c
    where c.start_time >= $2
      and c.start_time < $3
      and c.run_guid is distinct from $1
      and $3 > $2
    returning 1
  )
  select count(*)::bigint
  from deleted;
$$;

create or replace function public.complete_calendar_sync(
  p_run_guid uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_completed_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_deleted_count bigint := 0;
  v_event_count integer := 0;
  v_latest_source_at timestamptz;
  v_run public.source_sync_runs;
begin
  if p_run_guid is null then
    raise exception 'run_guid is required';
  end if;
  if p_window_start is null or p_window_end is null or p_window_end <= p_window_start then
    raise exception 'valid window_start/window_end are required';
  end if;

  select public.reconcile_calendar(p_run_guid, p_window_start, p_window_end)
    into v_deleted_count;

  select count(*)::integer,
         max(coalesce(last_modified_at_outlook, start_time, snapshot_time))
    into v_event_count, v_latest_source_at
  from public.calendar_events
  where run_guid = p_run_guid
    and start_time >= p_window_start
    and start_time < p_window_end;

  insert into public.source_sync_runs (
    source_type, external_run_id, status, completed_at,
    source_record_count, source_group_count, latest_source_at,
    memory_status, metadata
  ) values (
    'calendar', p_run_guid::text, 'completed', coalesce(p_completed_at, now()),
    v_event_count, 0, v_latest_source_at, 'pending',
    jsonb_build_object(
      'signal_type','sync_complete',
      'record_unit','event',
      'window_start',p_window_start,
      'window_end',p_window_end,
      'deleted_stale_events',v_deleted_count
    )
  )
  on conflict (source_type, external_run_id)
  do update set
    status='completed',
    completed_at=excluded.completed_at,
    source_record_count=excluded.source_record_count,
    latest_source_at=excluded.latest_source_at,
    memory_status=case
      when public.source_sync_runs.memory_status in ('complete','failed','skipped') then 'pending'
      else public.source_sync_runs.memory_status
    end,
    memory_processor_version=null,
    memory_started_at=null,
    memory_completed_at=null,
    memory_error=null,
    metadata=public.source_sync_runs.metadata || excluded.metadata,
    updated_at=now()
  returning * into v_run;

  return jsonb_build_object(
    'success',true,
    'source','calendar',
    'run_guid',v_run.external_run_id,
    'sync_run_id',v_run.id,
    'completed_at',v_run.completed_at,
    'events_in_run',v_run.source_record_count,
    'deleted_stale_events',v_deleted_count,
    'latest_source_at',v_run.latest_source_at,
    'memory_status',v_run.memory_status
  );
end;
$$;

revoke execute on function public.complete_calendar_sync(uuid, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.complete_calendar_sync(uuid, timestamptz, timestamptz, timestamptz) to service_role;
