# Migration history reconciliation (2026-08-28)

The local `migrations/` folder was out of sync with the live Supabase project: only 5 of 15 applied
remote migrations had local files, several with mismatched/malformed timestamps, plus a dead empty
duplicate file. The files here were reconstructed from the live schema (`mcp__supabase__list_migrations`,
`list_tables`, and direct introspection of `information_schema`, `pg_constraint`, `pg_indexes`, and
`pg_get_functiondef`) so local history now has one file per tracked remote version, in the same order.

Two caveats:

- **`20260823000000_baseline_pre_history_schema.sql`** is not a real migration. It captures objects
  (all of Mailroom's tables, `source_sync_runs`, and a few RPC functions) that exist live but don't
  correspond to *any* of the 15 tracked remote migrations — they predate migration tracking or were
  applied by hand. It's timestamped to sort first, purely so a fresh environment ends up with the
  same schema.
- **`20260826000233_fix_email_calendar_response_prefix_detection.sql`** is an empty placeholder. Its
  actual SQL is unrecoverable (only current schema state is queryable, not historical diffs); the
  migration immediately after it (`20260826000444_fix_calendar_subject_action.sql`) is confirmed to
  match the live function exactly, so whatever this one changed is already captured there.

All files are written idempotently (`create ... if not exists`, `create or replace function`) so they're
safe to run against an already-current database.

**Not done here:** the remote project's own migration history table
(`supabase_migrations.schema_migrations`) doesn't know about these local files yet. Running
`supabase db push`/`db pull` will still see drift until someone with CLI access runs, from a linked
project:

```
supabase link --project-ref thinevvooyqvodcvgvfp
supabase migration repair --status applied 20260823000000
supabase migration repair --status applied 20260823185246
# ...repeat for each version above, or migrate the batch with an equivalent script
```

This wasn't done because no Supabase access token or DB password was available in this environment —
only the MCP tools. Run this from a machine with `supabase login` access when convenient.
