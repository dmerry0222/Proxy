-- Build: Mailroom Action Model + Notion Surface + Power Automate Execution.
-- Additive only. Old category values ('workday_system','calendar_system') stay
-- valid in the CHECK for rollback safety; code now writes the clean
-- 'calendar'/'workday' names instead, and this migration backfills existing
-- rows so the two families of values are never split going forward.

alter table public.mailroom_conversations
  add column if not exists received_at timestamptz,
  add column if not exists requested_action text,
  add column if not exists is_meeting_invitation boolean not null default false;

alter table public.mailroom_conversations
  drop constraint if exists mailroom_conversations_category_check;
alter table public.mailroom_conversations
  add constraint mailroom_conversations_category_check
  check (category = any (array['needs_you','fyi','professional_news','low_value','workday_system','calendar_system','calendar','workday']));

alter table public.mailroom_conversations
  add constraint mailroom_conversations_requested_action_check
  check (requested_action is null or requested_action = any (array['archive','needs_attention','draft_reply','accept_invite','none']));

update public.mailroom_conversations set category = 'workday' where category = 'workday_system';
update public.mailroom_conversations set category = 'calendar' where category = 'calendar_system';

comment on column public.mailroom_conversations.received_at is 'Received timestamp of the latest message representing this conversation (emails.message_at), not analysis/ingestion time.';
comment on column public.mailroom_conversations.requested_action is 'Single canonical requested action, replacing the old needs_action/archive boolean pair. Null = not yet classified.';
comment on column public.mailroom_conversations.is_meeting_invitation is 'Deterministic (Graph-field-derived) flag: true only for an actual meeting invitation (calendar_message_kind = meeting_message, no calendar_action, not a cancellation). The sole gate for accept_invite eligibility -- never set from AI/text heuristics.';

create index if not exists mailroom_conversations_requested_action_idx on public.mailroom_conversations(requested_action) where requested_action is not null;
