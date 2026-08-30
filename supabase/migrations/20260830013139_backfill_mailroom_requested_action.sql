-- Build: Mailroom Action Model. Backfill for existing mailroom_conversations
-- rows created before requested_action/received_at/is_meeting_invitation
-- existed. Data-only: sets default/recommended state, never triggers an
-- Outlook mutation (no execution_commands rows are created here).

update public.mailroom_conversations mc
set
  received_at = e.message_at,
  is_meeting_invitation = coalesce(
    e.is_calendar_related = true and e.calendar_message_kind = 'meeting_message' and e.calendar_action is null,
    false
  )
from public.emails e
where e.outlook_message_id = mc.latest_message_id
  and mc.received_at is null;

update public.mailroom_conversations
set requested_action = case
  when category = 'needs_you' then 'needs_attention'
  when category in ('fyi','professional_news','low_value') then 'archive'
  when category in ('calendar') and is_meeting_invitation then 'accept_invite'
  when category in ('calendar','calendar_system') then 'archive'
  when category in ('workday','workday_system') then 'archive'
  else 'archive'
end
where requested_action is null;
