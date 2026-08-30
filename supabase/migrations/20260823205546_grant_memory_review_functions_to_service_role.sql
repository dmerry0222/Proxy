-- Reconstructed 2026-08-28 from live grants (resolve_memory_review_item and
-- resolve_memory_review_with_correction are executable only by
-- postgres/service_role live, confirming this revoke-from-public step).

revoke execute on function public.resolve_memory_review_item(uuid, text) from public;
grant execute on function public.resolve_memory_review_item(uuid, text) to service_role;

revoke execute on function public.resolve_memory_review_with_correction(uuid, text) from public;
grant execute on function public.resolve_memory_review_with_correction(uuid, text) to service_role;
