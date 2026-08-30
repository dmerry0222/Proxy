-- Reconstructed 2026-08-28 from live grants (information_schema.routine_privileges
-- shows get_memory_entity_context is executable only by postgres/service_role,
-- confirming the revoke-from-public step this migration's name implies).

revoke execute on function public.get_memory_entity_context(uuid) from public;
grant execute on function public.get_memory_entity_context(uuid) to service_role;
