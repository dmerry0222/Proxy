# Artifact ingestion

Proxy's ingestion subsystem accepts meeting artifacts, stores immutable
originals in the private Supabase `meeting-artifacts` bucket, parses searchable
sections, triangulates meeting metadata with Calendar, and proposes tasks and
Memory claims for review.

## Manual intake

Open `/ingestion` and either upload a file or paste Markdown. The first parser
supports Markdown, plain text, VTT, and JSON. PDF and DOCX originals are stored
safely but intentionally remain `stored_only` until dedicated parsers are
implemented.

Optional Markdown frontmatter:

```yaml
---
title: Weekly project sync
meeting_at: 2026-08-27T14:00:00-04:00
meeting_type: project_sync
participants:
  - person@suffolk.edu
confidentiality: internal
---
```

Participant email addresses enable deterministic identity resolution. Calendar
matching uses meeting time, title, and participant overlap. A Calendar match
corroborates logistics; it is not evidence that invitees attended or accepted
tasks.

## Provider adapters

All future connectors implement `ArtifactAdapter` and produce an
`IngestionInput`. The downstream storage, parsing, extraction, and review path
does not change. Stubs are listed in `src/lib/ingestion/adapters.ts` for Fathom,
Teams transcripts, Zoom, Plaud, Dropbox, OneDrive, and forwarded attachments.

## Processing guarantees

- SHA-256 content hashes make repeat imports idempotent.
- Original objects use immutable UUID/hash-based paths.
- Extraction failures are recorded in `ingestion_jobs` without losing files.
- Tasks remain candidates until accepted.
- Memory claims use the existing Memory review queue.
- Browser roles have no direct access to ingestion tables or private objects;
  the current workflow is server-side through Proxy.
