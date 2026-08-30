-- Reconstructed 2026-08-28 from the live function definition and grants
-- (no separate grant-only migration follows this one in tracked history,
-- so the grant is bundled here as it would have been originally).

create or replace function public.resolve_memory_pending_review_item(target_review_item_id uuid, action text)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  review_row public.memory_review_items%rowtype;
  pending_row public.memory_pending_context%rowtype;
  normalized_action text := lower(trim(action));
begin
  select *
  into review_row
  from public.memory_review_items
  where id = target_review_item_id;

  if not found then
    raise exception 'Memory review item not found';
  end if;

  if review_row.status <> 'pending' then
    raise exception 'Memory review item is already resolved or dismissed';
  end if;

  if review_row.pending_context_id is null then
    raise exception 'This review item is not linked to pending context';
  end if;

  select *
  into pending_row
  from public.memory_pending_context
  where id = review_row.pending_context_id;

  if not found then
    raise exception 'Linked pending context not found';
  end if;

  case normalized_action
    when 'follow_up' then
      update public.memory_pending_context
      set
        status = 'triggered',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'review_resolution', 'follow_up',
          'triggered_at', now()
        ),
        updated_at = now()
      where id = pending_row.id;

      update public.memory_review_items
      set
        status = 'resolved',
        resolution = jsonb_build_object(
          'action', 'follow_up',
          'resolved_at', now()
        ),
        resolved_at = now(),
        updated_at = now()
      where id = review_row.id;

    when 'keep_waiting' then
      update public.memory_pending_context
      set
        status = 'pending',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'review_resolution', 'keep_waiting',
          'reviewed_at', now()
        ),
        updated_at = now()
      where id = pending_row.id;

      update public.memory_review_items
      set
        defer_until = now() + interval '7 days',
        resolution = jsonb_build_object(
          'action', 'keep_waiting',
          'deferred_at', now()
        ),
        updated_at = now()
      where id = review_row.id;

    when 'resolved' then
      update public.memory_pending_context
      set
        status = 'resolved',
        resolved_at = now(),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'review_resolution', 'resolved',
          'reviewed_at', now()
        ),
        updated_at = now()
      where id = pending_row.id;

      update public.memory_review_items
      set
        status = 'resolved',
        resolution = jsonb_build_object(
          'action', 'resolved',
          'resolved_at', now()
        ),
        resolved_at = now(),
        updated_at = now()
      where id = review_row.id;

    when 'dismiss' then
      update public.memory_pending_context
      set
        status = 'dismissed',
        resolved_at = now(),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'review_resolution', 'dismiss',
          'reviewed_at', now()
        ),
        updated_at = now()
      where id = pending_row.id;

      update public.memory_review_items
      set
        status = 'dismissed',
        resolution = jsonb_build_object(
          'action', 'dismiss',
          'resolved_at', now()
        ),
        resolved_at = now(),
        updated_at = now()
      where id = review_row.id;

    else
      raise exception 'Invalid pending-context action. Use follow_up, keep_waiting, resolved, or dismiss.';
  end case;

  return jsonb_build_object(
    'review_item_id', review_row.id,
    'pending_context_id', pending_row.id,
    'action', normalized_action
  );
end;
$$;

revoke execute on function public.resolve_memory_pending_review_item(uuid, text) from public;
grant execute on function public.resolve_memory_pending_review_item(uuid, text) to service_role;
