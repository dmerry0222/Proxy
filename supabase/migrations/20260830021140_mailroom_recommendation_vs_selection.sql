-- Correction pass: preserve recommended -> selected -> executed as calibration
-- data, and separate selection from execution.
--
-- requested_action keeps its name (already populated) but is now explicitly
-- the SELECTED action. recommended_action is Proxy's classification-time
-- recommendation and is never overwritten by a human edit. The EXECUTED
-- action lives on execution_commands (payload.action + status='succeeded'),
-- which is already durable -- no third column needed here.

alter table public.mailroom_conversations
  add column if not exists recommended_action text,
  add column if not exists selected_action_source text not null default 'default';

alter table public.mailroom_conversations
  add constraint mailroom_conversations_recommended_action_check
  check (recommended_action is null or recommended_action = any (array['archive','needs_attention','draft_reply','accept_invite','none']));

alter table public.mailroom_conversations
  add constraint mailroom_conversations_selected_source_check
  check (selected_action_source = any (array['default','proxy_ui','notion']));

comment on column public.mailroom_conversations.requested_action is 'The SELECTED action (Proxy default, or a human override from Proxy UI/Notion). Selecting never executes; execution requires an explicit command.';
comment on column public.mailroom_conversations.recommended_action is 'Proxy classification-time recommendation. Never overwritten by human selection -- the baseline for measuring where recommendations disagree with decisions.';
comment on column public.mailroom_conversations.selected_action_source is 'Who last set requested_action: default (classification), proxy_ui, or notion.';

-- Backfill: existing rows had no separate recommendation, and their
-- requested_action was itself machine-assigned, so it IS the recommendation.
update public.mailroom_conversations
set recommended_action = requested_action
where recommended_action is null and requested_action is not null;

-- Reuse the existing calibration table rather than inventing a new one.
alter table public.mailroom_feedback
  add column if not exists original_action text,
  add column if not exists corrected_action text;

comment on column public.mailroom_feedback.original_action is 'Recommended action at the time of the override (calibration signal).';
comment on column public.mailroom_feedback.corrected_action is 'Action the human selected instead.';
