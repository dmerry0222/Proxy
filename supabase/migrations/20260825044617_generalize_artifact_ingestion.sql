alter table public.meeting_artifacts rename to artifacts;

alter table public.artifacts
  alter column meeting_id drop not null,
  add column content_kind text not null default 'unclassified'
    check (content_kind in ('unclassified', 'general', 'meeting'));

update public.artifacts
set content_kind = 'meeting'
where meeting_id is not null;

alter table public.artifacts
  drop constraint meeting_artifacts_meeting_id_fkey,
  add constraint artifacts_meeting_id_fkey
    foreign key (meeting_id) references public.meetings(id) on delete set null;

drop index if exists public.meeting_artifacts_hash_idx;
create unique index artifacts_content_hash_key
  on public.artifacts (content_hash);

create index artifacts_meeting_idx
  on public.artifacts (meeting_id)
  where meeting_id is not null;

update public.memory_sources
set canonical_table = 'artifacts', updated_at = now()
where canonical_table = 'meeting_artifacts';

