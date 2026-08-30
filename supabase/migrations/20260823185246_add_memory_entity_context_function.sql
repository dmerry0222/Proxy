-- Reconstructed 2026-08-28 from the live function definition (this repo's
-- local migrations/ folder had no file for this remote-tracked version --
-- see 20260823000000_baseline_pre_history_schema.sql for why).
--
-- Note: public.resolve_memory_review_item also exists live and is used by
-- Mailroom/Memory review, but predates every tracked migration (including
-- this one) with no corresponding version in remote history at all. It is
-- included here, at the earliest point Memory-review functionality is
-- referenced, purely so this repo's schema is complete -- its true origin
-- is unrecoverable.

create or replace function public.get_memory_entity_context(target_entity_id uuid)
returns jsonb
language sql
stable
set search_path to ''
as $$
with target as (
    select
        e.id,
        e.entity_type,
        e.canonical_name,
        e.description,
        e.status,
        e.visibility
    from public.memory_entities e
    where e.id = target_entity_id
      and e.status <> 'merged'
),
current_claims as (
    select
        c.id,
        c.claim_type,
        c.statement,
        c.valid_from,
        c.valid_to,
        c.learned_at,
        c.evidence_strength,
        c.confirmed_by_user,
        c.is_governing_context,
        c.visibility,
        coalesce((
            select count(*)
            from public.memory_claim_evidence ce
            where ce.claim_id = c.id
              and ce.relationship = 'supports'
        ), 0) as supporting_evidence_count,
        coalesce((
            select count(distinct coalesce(s.source_family_id, s.id))
            from public.memory_claim_evidence ce
            join public.memory_evidence ev on ev.id = ce.evidence_id
            join public.memory_sources s on s.id = ev.source_id
            where ce.claim_id = c.id
              and ce.relationship = 'supports'
        ), 0) as independent_source_count
    from public.memory_claims c
    join public.memory_claim_entities cme on cme.claim_id = c.id
    where cme.entity_id = target_entity_id
      and c.status = 'durable'
      and (c.valid_from is null or c.valid_from <= now())
      and (c.valid_to is null or c.valid_to > now())
),
pending_context as (
    select
        pc.id,
        pc.context_type,
        pc.summary,
        pc.detail,
        pc.status,
        pc.trigger_type,
        pc.trigger_at,
        pc.expires_at,
        pc.visibility
    from public.memory_pending_context pc
    where pc.primary_entity_id = target_entity_id
      and pc.status in ('pending', 'triggered')
      and (pc.trigger_at is null or pc.trigger_at <= now())
      and (pc.expires_at is null or pc.expires_at > now())
),
review_items as (
    select
        ri.id,
        ri.review_type,
        ri.title,
        ri.prompt,
        ri.priority,
        ri.payload,
        ri.claim_id,
        ri.pending_context_id
    from public.memory_review_items ri
    where ri.entity_id = target_entity_id
      and ri.status = 'pending'
      and (ri.defer_until is null or ri.defer_until <= now())
)
select case
    when not exists (select 1 from target) then null
    else jsonb_build_object(
        'entity', (
            select jsonb_build_object(
                'id', t.id,
                'type', t.entity_type,
                'name', t.canonical_name,
                'description', t.description,
                'status', t.status,
                'visibility', t.visibility
            )
            from target t
        ),
        'current_claims', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', cc.id,
                    'type', cc.claim_type,
                    'statement', cc.statement,
                    'valid_from', cc.valid_from,
                    'valid_to', cc.valid_to,
                    'learned_at', cc.learned_at,
                    'evidence_strength', cc.evidence_strength,
                    'confirmed_by_user', cc.confirmed_by_user,
                    'is_governing_context', cc.is_governing_context,
                    'visibility', cc.visibility,
                    'supporting_evidence_count', cc.supporting_evidence_count,
                    'independent_source_count', cc.independent_source_count
                )
                order by cc.is_governing_context desc, cc.valid_from desc nulls last, cc.learned_at desc
            )
            from current_claims cc
        ), '[]'::jsonb),
        'pending_context', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', pc.id,
                    'type', pc.context_type,
                    'summary', pc.summary,
                    'detail', pc.detail,
                    'status', pc.status,
                    'trigger_type', pc.trigger_type,
                    'trigger_at', pc.trigger_at,
                    'expires_at', pc.expires_at,
                    'visibility', pc.visibility
                )
                order by pc.trigger_at nulls last
            )
            from pending_context pc
        ), '[]'::jsonb),
        'review_items', coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'id', ri.id,
                    'type', ri.review_type,
                    'title', ri.title,
                    'prompt', ri.prompt,
                    'priority', ri.priority,
                    'options', ri.payload -> 'options',
                    'claim_id', ri.claim_id,
                    'pending_context_id', ri.pending_context_id
                )
                order by ri.priority desc, ri.id
            )
            from review_items ri
        ), '[]'::jsonb),
        'generated_at', now()
    )
end;
$$;
