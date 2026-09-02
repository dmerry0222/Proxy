-- created_by already allowed ai | user | system. Notion and the Proxy UI are
-- both "a human did this", but WHICH surface matters for the same reason
-- mailroom_conversations.selected_action_source does: it is how you tell a
-- decision Dave made in Notion from one Proxy proposed.
--
-- Split out rather than folded into the previous migration because it was
-- found the way these things actually get found: the first Notion pull wrote
-- created_by='notion' and the insert was rejected by the existing check.

alter table public.execute_touchpoints
  drop constraint if exists execute_touchpoints_created_by_check;

alter table public.execute_touchpoints
  add constraint execute_touchpoints_created_by_check
  check (created_by = any (array['ai', 'user', 'system', 'notion', 'proxy_ui']));

comment on column public.execute_touchpoints.created_by is
  'Who authored this enrichment: ai | user | system (pre-existing), plus notion | proxy_ui, which record WHICH human surface it came from -- the same distinction mailroom_conversations.selected_action_source makes.';
