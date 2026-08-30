-- Action Reconciliation Layer, Phase 2 cutover. task_evidence is fully
-- superseded by execution_evidence (added in
-- 20260829012651_add_action_reconciliation_foundation.sql, which also
-- backfilled its rows) now that extractMeetingKnowledge.ts and
-- interpretGenericArtifact.ts write execution_evidence exclusively.
--
-- Verified before writing this migration (2026-08-29): zero remaining code
-- readers or writers (`grep -r task_evidence src/` matches nothing), zero
-- foreign keys from any other table pointing at it, zero Postgres
-- functions/RPCs referencing it, no generated TypeScript types file in
-- this repo to regenerate, and no test coverage referencing it. Confirmed
-- via a live end-to-end parity test through the real /ingestion upload
-- flow that the refactored pipeline produces correct execution_items,
-- execution_evidence, reconciliation_runs/decisions, and Inspector
-- General trace/event visibility with zero new task_evidence writes.

drop table if exists public.task_evidence;
