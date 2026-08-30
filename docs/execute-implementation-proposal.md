# Execute implementation proposal

Status: approved; Slice 1 implemented on 2026-08-24

Implemented in Slice 1: the tracked `build_execute_slice_one` and
`add_execute_foreign_key_indexes` Supabase migrations, `execution_items`
ingestion compatibility, Execute server models/repositories/validation,
calendar-first desktop and Today/Next mobile surfaces, project activation,
manual execution-item creation, bundled work blocks, explicit block outcomes,
calendar outbox creation, and Outlook reconciliation by embedded work-block ID.

The remaining sequence below is still the roadmap for planner autonomy,
touchpoint workflows, durable reviews, and the CoS control loop.

## Repository findings

- `/execute` is currently a placeholder Server Component. There is no Execute domain module, calendar view, planner, or Execute API surface yet.
- `calendar_events` is the current Outlook mirror and already contains the event identity, timing, attendees, organizer, availability, recurrence, response, and Outlook timestamps Execute needs. Its `event_id` must remain canonical.
- Memory already owns project identity in `memory_entities` (`entity_type = 'project'`). Execute should reference that UUID, never copy project names into a second project catalog.
- The meeting-ingestion work has introduced `meetings`, `meeting_calendar_links`, and a small `tasks` table. The app only uses `tasks` as an extraction/review surface today, so it is cheaper and safer to evolve this table into execution items than to create a parallel canonical task table.
- Server data access is centralized in `src/lib/supabase/server.ts` with `server-only` and a service-role client. Pages fetch on the server; interactive review components post to thin Route Handlers. Execute should follow that split.
- Existing AI calls request bounded JSON, strip code fences, parse it, and perform basic validation before persistence. Execute needs a stricter discriminated action validator, but not a second AI architecture.
- Mailroom separates proposed actions from executed actions and persists feedback. That is the closest reusable autonomy/audit pattern.
- `memory_review_items` is a durable queue, but there is no durable, resumable review-session model. Execute needs its own session record while reusing the queue/payload/resolution conventions.
- The app shell is desktop-first and currently fixes a 256px sidebar with 32px content padding. Execute mobile work requires an app-shell change (bottom navigation or compact header), not merely responsive styles inside `/execute`.
- There is no reusable calendar UI or Outlook-write client. Resend is used for email handoff, and Power Automate is the existing external execution boundary. The first Outlook work-block integration should use that established handoff boundary, while keeping the provider adapter replaceable.
- The project uses Next.js 16.3.2. The bundled guidance supports keeping data/secret access in Server Components and `server-only` modules, with small Client Component islands for drag, resize, checklist, and command interactions; mutations may continue through Route Handlers.

## A. Minimum persistent data model

The first implementation should use seven operational tables. JSONB is used only for compact bounded structures, not as a substitute for core relational state.

### `execute_project_states`

One thin row per Execute-active Memory project.

| Field | Purpose |
| --- | --- |
| `id uuid` | Execute-local identity |
| `memory_project_entity_id uuid unique` | FK to `memory_entities`; canonical project identity |
| `status text` | `active`, `operationally_complete`, `inactive` |
| `next_plateau text` | The next project state Execute is trying to reach |
| `priority_directive jsonb` | Optional validated CoS directive |
| `activated_at`, `completed_at`, `created_at`, `updated_at` | Lifecycle/audit timestamps |

Critical items are not stored as an array here. They are execution items with a `critical_rank` of 1-3, allowing a normal FK and deterministic health checks.

### `execution_items` (evolve/rename existing `tasks`)

The existing table already has ingestion provenance, candidate review, assignee/requester links, due time, confidence, and metadata. Rename it and map existing statuses (`accepted` to `active`, `dismissed` to `cancelled`; preserve provenance in metadata), then add only operational fields.

| Field | Purpose |
| --- | --- |
| existing identity/title/description/source fields | Preserve ingestion provenance |
| `project_state_id uuid null` | FK to the thin Execute project state; null means loose work |
| `status text` | `candidate`, `active`, `completed`, `cancelled`, `deferred` |
| `responsibility text` | `mine` or `external` |
| `effort_minutes int null` | Rough estimate, not time tracking |
| `timing_kind text null` | `must` or `target` |
| `timing_at timestamptz null` | Timing pressure without a second due-date taxonomy |
| `critical_rank smallint null` | 1-3 within a project; normally only rank 1 |
| `waiting_since`, `expected_at` | Contextual waiting behavior |
| `related_person_entity_id uuid null` | FK to Memory person |
| `obligation_context text null` | Compact curated reason such as a promise |
| `priority_directive jsonb null` | Optional item-level CoS override |
| `deferred_until`, `completed_at`, `cancelled_at` | Lifecycle timestamps |

Planning coverage is derived: scheduled minutes in non-cancelled future blocks divided by `effort_minutes`. Do not persist `scheduled` as an item status.

### `execute_touchpoints`

Operational meaning attached to existing calendar events.

| Field | Purpose |
| --- | --- |
| `id uuid` | Relationship identity |
| `project_state_id uuid` | Project for which the event matters |
| `calendar_event_id text` | FK to `calendar_events.event_id` |
| `desired_state text` | What should be true by the event |
| `created_by text`, `confidence numeric`, timestamps | Correctable inference provenance |

Unique `(project_state_id, calendar_event_id)` permits one Outlook meeting to serve multiple projects without duplicating it.

### `execute_work_blocks`

Execute's reason for a time commitment and its reconciliation state.

| Field | Purpose |
| --- | --- |
| `id uuid` | Stable internal identity |
| `title text` | Human-facing block title |
| `status text` | `proposed`, `committed`, `completed`, `partial`, `missed`, `cancelled` |
| `planned_start`, `planned_end` | Execute proposal; used until an Outlook counterpart exists |
| `calendar_event_id text null unique` | FK to canonical Outlook event after sync |
| `provider_request_id text null` | Idempotency/correlation for Power Automate or later provider |
| `checklist jsonb` | Ephemeral generated checklist, replaceable per block |
| `completion_note text null` | Optional user context |
| `movement_history jsonb` | Small append-only reconciliation history |
| `last_reconciled_at`, timestamps | Sync health |

Once `calendar_event_id` resolves, displayed timing comes from `calendar_events`. If Outlook moves the event, reconciliation updates planned timing/history and accepts Outlook as truth. Deleting or cancelling a block never updates item lifecycle automatically.

### `execute_work_block_items`

Many-to-many block contents are required for bundled work and split work.

| Field | Purpose |
| --- | --- |
| `work_block_id`, `execution_item_id` | Composite PK/FKs |
| `allocated_minutes int null` | Coverage calculation |
| `position smallint` | Checklist/display ordering |

Each item is completed independently. Block `partial` is derived/recorded from the contained outcomes.

### `execute_capacity_windows`

Bounded, one-off availability such as “tonight 8-9.” Fields: `id`, `start_at`, `end_at`, `label`, `source_command`, `status` (`available`, `consumed`, `cancelled`, `expired`), timestamps. These rows do not mutate permanent working hours.

### `execute_attention_items` and `execute_review_sessions`

Attention items are the shared queue for risks, planning gaps, clarifications, stale/repeatedly displaced work, and execution intelligence. Fields: `id`, optional project/item/block/touchpoint FKs, `kind`, `urgency` (`interrupt_now`, `daily_review`, `weekly_review`), `audience` (`dave`, `cos`, `both`), `status`, concise `title`/`detail`, bounded `payload`, `dedupe_key`, and lifecycle timestamps.

Review sessions make daily/weekly review resumable with `id`, `review_type`, `status`, `horizon_start/end`, ordered `attention_item_ids uuid[]`, `current_index`, bounded `responses jsonb`, and timestamps. A session snapshots queue membership but the referenced attention rows remain canonical.

All new public tables should have RLS enabled even though the current app uses a server-side service role. Because Supabase is changing automatic Data API exposure, the migration should explicitly grant or revoke API role access rather than relying on project defaults. This single-user server-only app should initially revoke `anon`/`authenticated` access to Execute tables.

## B. Domain model

```ts
type ProjectExecutionState = {
  id: string;
  memoryProjectEntityId: string;
  status: "active" | "operationally_complete" | "inactive";
  nextPlateau: string | null;
  priorityDirective: PriorityDirective | null;
};

type ExecutionItem = {
  id: string;
  projectStateId: string | null;
  title: string;
  description: string | null;
  status: "candidate" | "active" | "completed" | "cancelled" | "deferred";
  responsibility: "mine" | "external";
  effortMinutes: number | null;
  timing: { kind: "must" | "target"; at: string } | null;
  criticalRank: 1 | 2 | 3 | null;
  waiting: { since: string; expectedAt: string | null; personEntityId: string | null } | null;
  obligationContext: string | null;
  coverage: { allocatedMinutes: number; estimatedMinutes: number | null };
};

type Touchpoint = {
  id: string;
  projectStateId: string;
  calendarEventId: string;
  desiredState: string;
};

type WorkBlock = {
  id: string;
  title: string;
  status: "proposed" | "committed" | "completed" | "partial" | "missed" | "cancelled";
  plannedStart: string;
  plannedEnd: string;
  calendarEventId: string | null;
  items: Array<{ executionItemId: string; allocatedMinutes: number | null; position: number }>;
  checklist: Array<{ id: string; label: string; checked: boolean }>;
  completionNote: string | null;
};

type PriorityDirective = {
  tier: "P1" | "P2" | "P3" | "background";
  why: string;
  desiredOutcome?: string;
  timing?: { kind: "must" | "target"; at: string };
  protection: "protected" | "normal" | "flexible";
  mayDisplace: Array<"P2" | "P3" | "background">;
  attentionPriority?: "high" | "normal" | "low";
  reassessAt?: string;
  escalationCondition?: string;
};

type PlannerAction =
  | { type: "activate_project"; memoryProjectEntityId: string; nextPlateau: string }
  | { type: "create_item"; item: ExecutionItemDraft }
  | { type: "revise_item"; itemId: string; patch: AllowedItemPatch }
  | { type: "nominate_critical_item"; itemId: string; rank: 1 | 2 | 3 }
  | { type: "associate_touchpoint"; projectStateId: string; calendarEventId: string; desiredState: string }
  | { type: "create_work_block"; block: WorkBlockDraft }
  | { type: "move_work_block"; workBlockId: string; start: string; end: string }
  | { type: "resize_work_block"; workBlockId: string; start: string; end: string }
  | { type: "release_work_block"; workBlockId: string }
  | { type: "create_attention_item"; attention: AttentionDraft };

type ExecutionIntelligence = {
  kind: "on_track" | "at_risk" | "capacity_shortfall" | "repeated_slip" |
    "duration_anomaly" | "unprotected_priority" | "aging_wait" | "brittle_plan";
  projectStateId?: string;
  executionItemId?: string;
  summary: string;
  evidence: Record<string, string | number | boolean>;
};

type ExecuteReviewItem = {
  id: string;
  kind: string;
  urgency: "interrupt_now" | "daily_review" | "weekly_review";
  status: "pending" | "resolved" | "dismissed" | "deferred";
  title: string;
  detail: string | null;
};

type ExecuteReviewSession = {
  id: string;
  reviewType: "daily" | "weekly";
  status: "active" | "completed" | "abandoned";
  attentionItemIds: string[];
  currentIndex: number;
  responses: Record<string, unknown>;
};
```

Draft and patch types must be explicit allowlists; planner output must never accept arbitrary database column/value maps.

## C. Planner contract

### Input packet

The planner receives one curated packet for a four-week horizon:

- horizon and timezone; working-hour rules plus temporary capacity windows
- fixed Outlook events with only operational fields, attendee involvement, and detected real-meeting conflicts
- existing work blocks with canonical reconciled time and contained item IDs
- Execute-active project states with Memory project name, plateau, directive, critical items, and touchpoints
- active/candidate execution items with responsibility, estimate, timing, coverage, waiting context, and concise obligation context
- pending attention items and recent movement/completion signals needed to revise rather than recreate the plan

Raw emails, Teams messages, transcripts, whole Memory histories, and inactive/someday projects are excluded. Deeper source retrieval is a separate on-demand operation.

### Output

Claude returns `{ planSummary, actions, intelligence }`, where `actions` is a discriminated union from the bounded vocabulary above. The natural-language summary is display-only. Only validated actions can mutate canonical state.

### Application validation

Before applying an action, normal code must verify:

1. Shape, enum values, UUIDs, timestamps, positive duration, horizon, and maximum action count.
2. Every referenced project, Memory entity, item, block, and calendar event exists and is in a compatible state.
3. A work block has at least one item, no duplicate item links, and fits a permitted discretionary/capacity window.
4. Proposed blocks do not overlap fixed busy events or other committed blocks; overlap never solves capacity.
5. Only Proxy-created work blocks may move/resize/release. Any calendar event with other people is immutable by Execute.
6. Item completion/cancellation is never inferred from a block mutation. Completion requires an explicit user action.
7. Protected directive displacement is allowed by the directive; protected conflicts become attention items.
8. `must` shortfall, real meeting conflicts, and imminent material ambiguity are emitted as `interrupt_now`; other ambiguity is queued for review.
9. Every mutation is idempotent through an action/request key and recorded with actor (`planner`, `user`, `sync`, `system`) plus before/after evidence.

Apply a planner batch transactionally where possible. External calendar delivery is an outbox-style second step: commit the intent, send through the provider adapter, then reconcile the resulting Outlook `event_id` on ingestion.

### Autonomy

Auto-apply: high-confidence project association, item creation, critical nomination, touchpoint association, and creation/movement/resizing/bundling of Proxy work blocks inside permitted discretionary time when priority rules are satisfied.

Surface without applying: moving/cancelling real meetings, inviting/contacting anyone, changing external deadlines, completing items, using off-hours without a capacity window, strategic choice between conflicting protected directives, and material ambiguities that would consume or displace substantial time.

## D. UI structure

### Desktop

- `/execute` remains a Server Component that loads a compact `ExecuteDashboard` DTO.
- `ExecuteCalendar` occupies roughly 75% of the canvas. Start with a dependency-light custom two-week time grid because no calendar library exists; abstract the event renderer so a library can replace it later.
- `PlanningAttentionRail` shows only capacity gaps, unscheduled protected work, project health gaps, aging waits, touchpoint risk, and real-meeting conflicts.
- Selecting a block opens `WorkBlockDrawer` for its items, ephemeral checklist, Done/Partial/Missed, note, and safe rescheduling controls.
- Selecting a project opens a focused execution view: Memory identity/context link, plateau, critical item(s), next touchpoint, waiting items, and calendar coverage.
- A persistent compact `ExecuteCommandBar` accepts natural language, shows a concise interpretation/change summary, and makes low-cost corrections easy.

### Mobile

- Replace the fixed sidebar with bottom navigation or a compact header at the app-shell breakpoint.
- Default Execute view is `Today / Next`: current/next block, immediate fixed commitments, one recommended action, and urgent attention—not a squeezed week grid.
- Work-block checklist is a full-screen, thumb-friendly surface with Done/Partial/Missed and optional voice-ready text input.
- Quick command is always one tap away.
- Review queue is card-based; daily and weekly sessions resume from the persisted current index.
- Project/touchpoint context is lightweight and drill-in; dense week manipulation stays desktop-first.

## E. Implementation sequence

### Slice 1: believable protected time

1. Add checked-in Supabase migration infrastructure and the minimal tables/constraints/indexes/RLS above; evolve `tasks` into `execution_items` and update ingestion references.
2. Add `src/lib/execute/types.ts`, strict validators, repository functions, and a server-loaded dashboard DTO.
3. Implement project activation from an existing Memory project, execution-item creation, bundled block creation, coverage calculation, and a calendar-first two-week Execute screen.
4. Implement explicit Done/Partial/Missed. Verify that partial/missed blocks leave items active and bundled items complete independently.
5. Add a calendar-provider interface and Power Automate/ICS outbox adapter. Reconcile synced `calendar_events` by provider correlation/`ical_uid`, treating Outlook timing as truth.

Acceptance path: Memory project -> active execution state/plateau -> execution item -> protected block visible on Execute -> Outlook counterpart -> moved Outlook event reconciles -> explicit partial/completion -> remaining work stays/replans.

### Slice 2: touchpoints and realistic planning

Add touchpoint associations, next-four-week event loading, attendee-aware real meeting conflict detection, must/target risk, temporary capacity, and deterministic free-time/capacity calculations. The deterministic scheduler should find valid slots; AI chooses among valid slots and explains material changes.

### Slice 3: review and control loop

Add attention items, resumable daily/weekly sessions, project health checks, aging waiting-person/upcoming-meeting resurfacing, and CoS directive intake/Execute intelligence output.

### Slice 4: natural-language replanning

Add curated planner packets, validated action batches, idempotent application, autonomous safe block movement/bundling, concise change summaries, and correction feedback. Add duration calibration only after sufficient evidence exists.

## Decisions to preserve

- `tasks` is an early ingestion seam, not a reason to build Todoist. Evolve it into the product term `execution_items` rather than keeping two canonical work tables.
- Calendar conflict, coverage, and free-time math are deterministic application logic. AI interprets intent and proposes bounded mutations.
- Outlook remains canonical for external event timing; Execute remains canonical for purpose and item membership.
- Project identity stays in Memory.
- Checklists stay block-local and replaceable.
- No production schema change should be applied until the Slice 1 migration is reviewed as a single coherent change.
