-- Reconstructed 2026-08-28 from live pg_indexes. Covering indexes for the
-- Execute schema's optional foreign keys, added after the initial slice-one
-- build (20260825004537_build_execute_slice_one.sql).

create index if not exists execution_items_assignee_idx on public.execution_items(assignee_entity_id);
create index if not exists execution_items_requester_idx
  on public.execution_items(requester_entity_id) where requester_entity_id is not null;
create index if not exists execution_items_related_person_idx
  on public.execution_items(related_person_entity_id) where related_person_entity_id is not null;
create index if not exists execution_items_source_meeting_idx
  on public.execution_items(source_meeting_id) where source_meeting_id is not null;
create index if not exists execution_items_source_artifact_idx
  on public.execution_items(source_artifact_id) where source_artifact_id is not null;

create index if not exists execute_attention_items_project_idx
  on public.execute_attention_items(project_state_id) where project_state_id is not null;
create index if not exists execute_attention_items_execution_item_idx
  on public.execute_attention_items(execution_item_id) where execution_item_id is not null;
create index if not exists execute_attention_items_work_block_idx
  on public.execute_attention_items(work_block_id) where work_block_id is not null;
create index if not exists execute_attention_items_touchpoint_idx
  on public.execute_attention_items(touchpoint_id) where touchpoint_id is not null;

create index if not exists execute_work_block_items_item_idx on public.execute_work_block_items(execution_item_id);
create index if not exists execute_calendar_outbox_work_block_idx on public.execute_calendar_outbox(work_block_id);
create index if not exists execute_touchpoints_calendar_event_idx on public.execute_touchpoints(calendar_event_id);
