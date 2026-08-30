-- Correct the Accept Invite safety gate.
--
-- The prior predicate (calendar_message_kind='meeting_message' AND
-- calendar_action IS NULL) had real false positives: 'meeting_message' is
-- the RESIDUAL bucket for calendar mail whose subject didn't match a
-- response/cancellation prefix, and it also captures FORWARDED meeting
-- mail, which carries identical calendar headers (including the same
-- Calendar-Series-Instance-Id) as the genuine invitation. Observed in real
-- mail via X-MS-Exchange-MeetingForward-Message: Forward.
--
-- Corrected predicate is fully structural (headers + addressing); no
-- AI/text inference may enable Accept Invite. Mirrors
-- isActionableMeetingInvitation() in normalizeOutlookMetadata.ts.

update public.mailroom_conversations mc
set is_meeting_invitation = coalesce((
  e.is_calendar_related
  and e.calendar_message_kind = 'meeting_message'
  and e.calendar_action is null
  and e.calendar_series_instance_id is not null
  and not exists (
    select 1 from jsonb_array_elements(e.internet_message_headers) h
    where lower(h->>'name') = 'x-ms-exchange-meetingforward-message'
  )
  and e.subject !~* '^\s*(fw|fwd|re)\s*:'
  and lower(e.direction) = 'incoming'
  and (coalesce(array_to_string(e.to_recipients,';'),'') || ';' || coalesce(array_to_string(e.cc_recipients,';'),''))
      ilike '%dmerry@suffolk.edu%'
  and e.is_in_inbox = true
), false)
from public.emails e
where e.outlook_message_id = mc.latest_message_id;

update public.mailroom_conversations
set requested_action = 'archive'
where requested_action = 'accept_invite' and is_meeting_invitation = false;

update public.mailroom_conversations
set recommended_action = 'archive'
where recommended_action = 'accept_invite' and is_meeting_invitation = false;
