-- Reconstructed 2026-08-28 from the live function definition.

create or replace function public.resolve_memory_review_with_correction(target_review_item_id uuid, corrected_statement text)
returns jsonb
language plpgsql
set search_path to 'public'
as $$
declare
  review_row public.memory_review_items%rowtype;
  claim_row public.memory_claims%rowtype;
  source_id uuid;
  evidence_id uuid;
  new_claim_id uuid;
begin
  if corrected_statement is null or btrim(corrected_statement) = '' then
    raise exception 'Correction text is required';
  end if;

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

  if review_row.claim_id is null then
    raise exception 'This review item is not linked to a claim';
  end if;

  select *
  into claim_row
  from public.memory_claims
  where id = review_row.claim_id;

  if not found then
    raise exception 'Linked Memory claim not found';
  end if;

  insert into public.memory_sources (
    source_type,
    title,
    content_text,
    source_at,
    metadata
  ) values (
    'user_correction',
    'User correction from Memory Review',
    btrim(corrected_statement),
    now(),
    jsonb_build_object(
      'review_item_id', review_row.id,
      'corrects_claim_id', claim_row.id
    )
  )
  returning id into source_id;

  insert into public.memory_evidence (
    source_id,
    evidence_type,
    content,
    visibility,
    extracted_by,
    metadata
  ) values (
    source_id,
    'observation',
    btrim(corrected_statement),
    claim_row.visibility,
    'user',
    jsonb_build_object(
      'review_item_id', review_row.id,
      'corrects_claim_id', claim_row.id
    )
  )
  returning id into evidence_id;

  insert into public.memory_evidence_entities (
    evidence_id,
    entity_id,
    relationship
  )
  select
    evidence_id,
    ce.entity_id,
    coalesce(ce.role, 'subject')
  from public.memory_claim_entities ce
  where ce.claim_id = claim_row.id;

  insert into public.memory_claims (
    claim_type,
    statement,
    status,
    valid_from,
    learned_at,
    evidence_strength,
    promotion_basis,
    confirmed_by_user,
    is_governing_context,
    visibility,
    created_by,
    metadata
  ) values (
    claim_row.claim_type,
    btrim(corrected_statement),
    'durable',
    now(),
    now(),
    'confirmed',
    'user_correction',
    true,
    claim_row.is_governing_context,
    claim_row.visibility,
    'user',
    jsonb_build_object(
      'review_item_id', review_row.id,
      'corrects_claim_id', claim_row.id
    )
  )
  returning id into new_claim_id;

  insert into public.memory_claim_entities (
    claim_id,
    entity_id,
    role
  )
  select
    new_claim_id,
    ce.entity_id,
    ce.role
  from public.memory_claim_entities ce
  where ce.claim_id = claim_row.id;

  insert into public.memory_claim_evidence (
    claim_id,
    evidence_id,
    relationship
  ) values (
    new_claim_id,
    evidence_id,
    'supports'
  );

  update public.memory_claims
  set
    status = 'evidence_only',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'review_resolution', 'corrected_by_user',
      'corrected_by_claim_id', new_claim_id,
      'reviewed_at', now()
    ),
    updated_at = now()
  where id = claim_row.id;

  update public.memory_review_items
  set
    status = 'resolved',
    resolution = jsonb_build_object(
      'action', 'correction',
      'corrected_statement', btrim(corrected_statement),
      'new_claim_id', new_claim_id,
      'resolved_at', now()
    ),
    resolved_at = now(),
    updated_at = now()
  where id = review_row.id;

  return jsonb_build_object(
    'review_item_id', review_row.id,
    'original_claim_id', claim_row.id,
    'new_claim_id', new_claim_id,
    'source_id', source_id,
    'evidence_id', evidence_id,
    'action', 'correction'
  );
end;
$$;
