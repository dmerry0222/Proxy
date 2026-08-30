create or replace function public.normalize_outlook_email_metadata()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  traffic_diagnostic text;
  auto_submitted text;
  generated_source text;
  precedence_value text;
  subject_action text;
begin
  select h.value into traffic_diagnostic from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-ms-traffictypediagnostic' limit 1;
  select h.value into new.calendar_series_instance_id from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-ms-exchange-calendar-series-instance-id' limit 1;
  select h.value into new.calendar_originator_id from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-ms-exchange-calendar-originator-id' limit 1;
  select h.value into auto_submitted from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'auto-submitted' limit 1;
  select h.value into generated_source from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-ms-exchange-generated-message-source' limit 1;
  select h.value into precedence_value from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'precedence' limit 1;
  select h.value into new.list_id from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'list-id' limit 1;
  select h.value into new.parent_message_id from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'in-reply-to' limit 1;
  select h.value into new.auto_response_suppress from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-auto-response-suppress' limit 1;

  subject_action := substring(lower(coalesce(new.subject, '')) from '^\s*(accepted|declined|tentative|cancell?ed):');
  new.calendar_action := case
    when subject_action in ('canceled', 'cancelled') then 'cancelled'
    when subject_action in ('accepted', 'declined', 'tentative') then subject_action
    else null
  end;
  new.is_calendar_related := coalesce(traffic_diagnostic ilike '%ee_meetingmessage%', false)
    or new.calendar_series_instance_id is not null or new.calendar_originator_id is not null
    or new.calendar_action is not null;
  new.calendar_message_kind := case
    when new.calendar_action = 'cancelled' then 'cancellation'
    when new.calendar_action is not null then 'meeting_response'
    when new.is_calendar_related then 'meeting_message'
    else null
  end;
  new.is_auto_reply := coalesce(auto_submitted ilike '%auto-generated%', false)
    or coalesce(generated_source ilike '%mailbox rules agent%', false);
  new.is_mailing_list := coalesce(precedence_value ilike '%list%', false) or new.list_id is not null
    or exists (select 1 from jsonb_to_recordset(coalesce(new.internet_message_headers, '[]'::jsonb)) h(name text, value text) where lower(h.name) = 'x-beenthere');
  new.is_system_generated := new.is_calendar_related or new.is_auto_reply;
  new.has_real_attachments := exists (
    select 1 from jsonb_array_elements(coalesce(new.attachments, '[]'::jsonb)) attachment
    where coalesce((attachment ->> 'isInline')::boolean, false) = false
  );
  return new;
end;
$$;

update public.emails set subject = subject;
