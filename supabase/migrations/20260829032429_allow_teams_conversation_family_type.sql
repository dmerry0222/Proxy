-- Genuine pre-existing defect, discovered during Phase 4 live testing:
-- src/lib/memory/processTeamsConversationDelta.ts has always inserted
-- memory_source_families.family_type = 'teams_conversation', but the live
-- CHECK constraint only ever allowed
-- (meeting, conversation, document_version, import_batch, other) --
-- meaning this function has never been able to successfully run against
-- the live schema (every call would fail on findOrCreateChatFamily's
-- insert). Widening the constraint, additive only -- no existing rows or
-- allowed values are removed.

alter table public.memory_source_families
  drop constraint memory_source_families_family_type_check;

alter table public.memory_source_families
  add constraint memory_source_families_family_type_check
  check (family_type = any (array['meeting', 'conversation', 'teams_conversation', 'document_version', 'import_batch', 'other']));
