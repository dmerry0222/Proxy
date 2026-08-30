# Claude Code Build Prompt: Inspector General

Build a new **Inspector General** capability for Proxy.

Inspector General is Proxy’s unified **diagnostic, observability, traceability, and accountability layer**. It should help a non-technical product owner understand:

> **What did Proxy see, what did it understand, what did it decide, what did it do, and did anything go wrong?**

This should not feel like a developer console or a database viewer. It should present Proxy’s internal behavior in clear, human-readable language while preserving enough technical depth underneath for debugging code, model behavior, ingestion logic, Supabase operations, and agent decisions.

The core design principle is:

> **Human explanation first, reasoning second, technical detail third.**

Inspector General should become the common diagnostic framework for Memory, Mailroom, Execute, calendar ingestion, documents, meeting notes, Teams, Chief of Staff, Delegator, and future Proxy modules.

---

# 1. Product Role

Inspector General is **not another operational Proxy agent** like Memory, Execute, or Mailroom.

It is the independent oversight layer that answers two different questions:

### Is Proxy working?

Examples:

* Did the email arrive?
* Did the Power Automate flow complete?
* Was an attachment downloaded?
* Was a PDF/document successfully parsed?
* Did a model invocation fail?
* Did a Supabase operation fail?
* Did calendar ingestion stop?
* Did downstream processing complete?
* Is a queue backed up?
* Is a screen slow because of rendering, database access, or AI activity?

### Why did Proxy believe or do this?

Examples:

* Why did Memory create this claim?
* Why did Proxy ask me this Memory Review question?
* Why was another apparent duplicate suppressed?
* Why did this email become a task?
* Why did this meeting not generate a follow-up?
* Why was this person matched to this entity?
* Why does Chief of Staff think this is important?
* Why did Execute schedule this task here?
* Why was this evidence attached to an existing claim instead of creating a new claim?

Both types of oversight should live in the same system.

---

# 2. UX Placement

Add **Inspector General** near the bottom of the main Proxy navigation, conceptually closer to Settings/system controls than to the primary operational modules.

Suggested presentation:

**Inspector General**
*Oversight & Diagnostics*

Do not overuse the government metaphor within the UI. The actual sections and controls should use plain language.

Inspector General should also be reachable contextually.

Where appropriate, add a subtle action such as:

* `Trace`
* `Why?`
* `How did Proxy get this?`

to objects such as:

* Memory claims
* Memory Review items
* emails
* meetings
* tasks
* projects
* documents
* people
* Chief of Staff recommendations
* Execute placements

That action should open Inspector General focused on that object.

---

# 3. Main Inspector General Experience

Build a dedicated full-screen Inspector General workspace.

The landing page should provide these sections:

1. **System Health**
2. **Needs Attention**
3. **Recent Activity**
4. **Trace**
5. **Memory**
6. **Performance**

Tabs, segmented navigation, or another compact pattern are fine.

The default view should remain highly readable.

---

# 4. System Health

Provide a compact health summary of major Proxy subsystems.

For example:

```text
SYSTEM HEALTH

✓ Email
✓ Calendar
✓ Documents
✓ Memory
✓ Execute
⚠ Meeting Notes
✓ Background Processing
```

Health state should ideally support:

* healthy
* degraded
* failing
* stale
* unknown

Do not expose implementation jargon as the primary label.

A warning should say:

> Calendar sync has not completed recently.

rather than:

> cron job xyz failed.

Technical details can be available deeper in the interface.

Possible monitored areas include:

* email ingestion
* calendar ingestion
* Teams ingestion
* document ingestion
* attachment handling
* meeting-note ingestion
* Memory processing
* Memory Review generation
* Execute processing
* model/API calls
* Supabase connectivity
* background jobs
* Power Automate completion signals
* document parsing
* entity resolution
* performance

Implement this so future modules can register their health without requiring a redesign of the Inspector General UI.

---

# 5. Needs Attention

Create a human-readable failure/problem queue.

Avoid names like:

* exception queue
* DLQ
* stack trace monitor

The UI should simply say:

**Needs Attention**

Example:

```text
NEEDS ATTENTION

Documents
⚠ Proxy couldn't read these meeting notes.
  Grad Strategy Notes.docx
  [Inspect] [Retry]

Identity
? Proxy isn't sure whether these are the same person.
  Liz Henderson ↔ Elizabeth Henderson
  [Resolve]

Processing
⚠ Calendar synchronization stopped unexpectedly.
  Last successful: 4:32 PM
  [Inspect] [Retry]
```

Support issue types such as:

* source not received
* attachment download failure
* document extraction failure
* unsupported document format
* malformed source record
* entity resolution ambiguity
* duplicate source ambiguity
* processing/model failure
* downstream write failure
* queue timeout
* stale integration
* calendar ingestion failure
* Memory reconciliation failure
* Execute processing failure
* repeated/recoverable job failure

Each issue should have:

* human-readable explanation
* affected object/source
* first observed timestamp
* latest observed timestamp
* current status
* severity
* retryability
* number of attempts
* related trace
* technical details
* resolution state

Possible resolution states:

* open
* retrying
* resolved automatically
* resolved manually
* ignored/dismissed

Do not silently delete resolved failures. Preserve diagnostic history.

---

# 6. End-to-End Activity Trail

Create a standardized activity/trace system that spans Proxy.

Every meaningful operation should emit structured diagnostic events.

Conceptual event lifecycle:

```text
received
→ stored
→ parsed
→ identified
→ extracted
→ reconciled
→ decided
→ acted
→ completed
```

Not every process needs every stage.

Examples:

### Email

```text
Received from Outlook
→ Stored in Supabase
→ Email body parsed
→ Heather O'Leary recognized
→ Graduate Program Health Rubric matched
→ 4 candidate observations extracted
→ Memory reconciled them
→ 2 became supporting evidence
→ 1 temporary context
→ 1 suppressed
→ No review required
→ Completed
```

### Meeting notes

```text
Zoom notes email received
→ Attachment downloaded
→ Document parsed
→ Meeting matched to calendar event
→ Attendees recognized
→ 3 decisions extracted
→ 2 commitments extracted
→ Memory updated
→ 2 Execute items proposed
→ Completed
```

### Failure

```text
Attachment received
→ Download attempted
→ Failed
→ Retry attempted
→ Failed
→ Needs Attention item created
```

---

# 7. Shared Diagnostic Event Model

Implement a common underlying diagnostic/activity event model rather than building bespoke logging separately into each Proxy module.

Inspect the existing schema before finalizing the design.

A likely event record should support fields conceptually equivalent to:

```text
id
trace_id
parent_event_id
event_type
stage
module
agent
status
severity
occurred_at
started_at
completed_at

source_type
source_id

object_type
object_id

human_summary
human_detail

decision_type
decision_reason

technical_code
technical_detail

metadata jsonb
duration_ms
```

Do not blindly use these exact names if the existing architecture suggests better ones.

Important concepts:

### `trace_id`

Connect all events belonging to one logical journey.

### `parent_event_id`

Allow branching.

For example:

one email may produce:

* a Memory branch
* an Execute branch
* a project-association branch

### Human explanation

Every meaningful diagnostic event should have a short explanation suitable for the Inspector General interface.

Do not require the UI to reverse-engineer human meaning from low-level technical logs.

### Technical metadata

Preserve IDs, model names, versions, timings, errors, function names, source IDs, request IDs, etc. in structured metadata or dedicated fields.

---

# 8. Trace Experience

The **Trace** is the most important Inspector General interaction.

From any source/object, show its journey through Proxy visually.

Example:

```text
Heather O'Leary
Graduate Program Portfolio Health Rubric
Aug 24 · Email

RECEIVED
✓ Outlook
✓ Power Automate
✓ Supabase

UNDERSTOOD
✓ Heather O'Leary → existing person
✓ Graduate Program Health Rubric → existing project
✓ 4 observations extracted

RECONCILED WITH MEMORY
✓ 2 supported things Proxy already knew
✓ 1 added temporary project context
○ 1 suppressed as not useful

ACTIONS
✓ Existing Memory claim strengthened
✓ Project updated
○ No Memory Review needed
○ No Execute task needed
```

Allow sections to expand.

Clicking:

> `4 observations extracted`

could display:

```text
"Heather leads the Graduate Program Health Rubric."

Matched:
Existing durable claim:
"Heather is leading development of the Graduate Program Portfolio Health Rubric."

Decision:
Supporting evidence.

Why:
The existing claim was previously confirmed by Dave and the new
observation does not materially change the proposition.

Result:
Evidence attached to existing claim.
No Memory Review created.
```

This is the level at which Proxy logic becomes debuggable.

---

# 9. Three Levels of Diagnostic Detail

Use progressive disclosure consistently.

## Level 1: Human explanation

Default.

Example:

> Proxy recognized this as supporting something it already knew.

## Level 2: Decision explanation

Accessible via `Why?`, expansion, or drill-down.

Example:

```text
Existing Memory:
Heather leads the Graduate Program Health Rubric.

New observation:
Heather is working on the Grad Program Health Rubric.

Existing claim is durable and was previously confirmed by Dave.

Decision:
Treat as supporting evidence rather than creating another claim.
```

## Level 3: Technical details

Hidden by default.

Example:

```text
source_id
e9d8...

entity_id
ec369...

claim_id
cdd60...

pipeline
email_ingestion

ingestion_version
4

reconciliation
supports_existing

similarity
0.93

duration
842ms
```

Where useful, also expose:

* raw source
* extracted JSON
* model response
* request metadata
* database IDs
* processing version
* stack/error details

Do not expose secrets, API keys, tokens, service-role credentials, or sensitive environment variables.

---

# 10. Memory Diagnostic View

Build a dedicated Memory section within Inspector General.

This should make Memory behavior understandable at a system level.

Potential summary:

```text
MEMORY · LAST 7 DAYS

                      Observed   Kept   Review   Suppressed

People                   186      42      11        133
Projects                 104      31       7         66
Preferences               18       3       2         13
Working context          221      37       9        175
```

Use whatever categories fit the actual Memory schema.

Important metrics:

* evidence observed
* candidate claims generated
* claims created
* claims merged
* evidence attached to existing claims
* duplicates suppressed
* review items created
* review items confirmed
* review items dismissed
* claims superseded
* contradictions detected
* context expired
* evidence-only decisions

Add a section like:

### Things Proxy saw repeatedly

Example:

```text
Heather O'Leary
Graduate Program Health Rubric

12 observations
5 sources

→ consolidated into 1 durable claim
→ 8 became supporting evidence
→ 2 temporary context
→ 1 suppressed based on prior feedback
→ 0 additional review questions
```

This is important because Proxy should not merely reveal mistakes.

It should also let the user see when **it successfully avoided unnecessary interruptions**.

---

# 11. Memory Claim Traceability

For any claim, allow Inspector General to show:

* canonical claim statement
* claim type
* current status
* confidence/evidence strength
* confirmed_by_user
* created date
* updated date
* valid/effective dates
* supersession history
* connected entity/entities
* all supporting evidence
* conflicting evidence
* related review items
* related user corrections
* candidate claims that were merged into it
* candidate claims suppressed as equivalent
* source documents/emails/events

For an entity/person/project, allow viewing:

```text
Heather O'Leary

Memory
├── durable claims
├── candidate claims
├── supporting evidence
├── superseded claims
├── excluded claims
├── pending reviews
└── suppressed duplicates
```

Do not surface giant raw tables by default.

---

# 12. Cross-Proxy Entity View

Eventually Inspector General should be able to reconstruct Proxy's understanding of a person, project, meeting, or other object across modules.

Please build the architecture so this becomes possible.

Example:

```text
Heather O'Leary

PERSON
│
├── Sources
│   ├── 38 emails
│   ├── 14 meetings
│   └── 6 documents
│
├── Memory
│   ├── 7 durable claims
│   ├── 41 evidence items
│   ├── 3 superseded
│   └── 2 pending review
│
├── Execute
│   ├── 4 completed commitments
│   └── 1 waiting-on
│
└── Projects
    ├── Graduate Program Portfolio
    └── ...
```

Initial implementation does not need every relationship if they do not yet exist in Proxy.

Build the trace/event architecture so these relationships can be added incrementally.

---

# 13. Search and Filters

Inspector General should support plain-language exploration.

At minimum provide search/filtering for:

* person/entity
* project
* meeting
* document
* email subject
* source type
* module
* date/time
* trace status
* failure status
* review status
* event type
* severity

Searching `Heather O'Leary` should bring together relevant activity instead of only exact text matches in one table.

Where practical, use existing entity relationships to improve results.

---

# 14. Timeline / Recent Activity

Create a compact chronological activity feed.

Example:

```text
TODAY

7:31 PM   📄 Meeting notes received
          Graduate Program Strategy
          ✓ Read → 6 facts → 2 tasks → Memory

7:18 PM   ✉ Email received
          Heather O'Leary · Graduate Program Health Rubric
          ✓ Read → matched existing project
                 → 3 observations added as evidence
                 → 0 Memory questions

6:42 PM   📅 Meeting updated
          Hayley / Dave
          ✓ Existing meeting updated

6:14 PM   📎 Attachment received
          FY27 Budget Draft.pdf
          ⚠ Couldn't extract text
          [Retry]
```

The feed should favor meaningful high-level events over noise.

Do not show every SQL operation or React render.

---

# 15. "This Seems Wrong" Feedback

Add a lightweight diagnostic feedback mechanism.

From a trace, event, decision, Memory claim, or other Inspector General item, provide:

**This seems wrong**

Possible options:

```text
Proxy misunderstood this
These are duplicates
This should have become a task
This shouldn't have become a task
Proxy should have remembered this
Proxy shouldn't remember this
Wrong person/project
Something else
```

Store:

* associated object
* trace
* event
* chosen issue type
* optional free-text explanation
* timestamp
* current resolution status

For now, this can primarily support debugging.

Do not automatically alter Memory or Execute unless an existing intentional correction workflow already handles that safely.

Build it in a way that could later feed Proxy's calibration/learning loop.

---

# 16. Performance View

Add a Performance section.

This should help diagnose the UI slowness discussed elsewhere.

Human-level view:

```text
PERFORMANCE · TODAY

Navigation

✓ Mailroom      120ms
✓ Memory        180ms
⚠ Execute       1.8s
✓ CoS           240ms


Slow operations

Execute initial query        1.4s
Meeting detail fetch         820ms
Memory entity search         610ms


Background activity

Memory processing            Running
Email ingestion              Idle
Calendar reconciliation      Completed 7:31 PM
```

Instrument useful categories such as:

* route navigation time
* server rendering
* client rendering where meaningful
* major API calls
* Supabase query duration
* document parsing duration
* AI/model invocation duration
* background job duration
* cache hit/miss
* stale-while-revalidate activity

Avoid logging every tiny operation.

The purpose is to identify meaningful bottlenecks.

---

# 17. Performance Architecture Principle

Proxy navigation should not itself trigger unnecessary intelligence.

Inspector General should make it possible to tell the difference between:

* UI rendering
* data fetching
* Supabase querying
* AI/model processing
* ingestion jobs
* background reconciliation

We want to detect architecture problems such as:

> User clicks Execute → Execute makes a model call → screen blocks.

The desired architecture is generally:

> Intelligence computes state → state is persisted → UI displays state quickly → background refresh occurs independently.

Inspector General should help validate that behavior.

---

# 18. Data Retention and Noise Control

Diagnostic instrumentation itself must not become a performance problem.

Design retention consciously.

Possible approach:

### Keep longer-term:

* traces
* failures
* significant decision events
* user feedback
* high-level processing outcomes
* performance aggregates

### Retain shorter-term / sample:

* very granular technical events
* repetitive successful heartbeat events
* low-value timing details

Do not implement aggressive deletion without considering debugging needs.

If introducing retention jobs, make them configurable.

---

# 19. Human-Readable Explanations

Do not rely on raw technical messages.

Every event type should be capable of rendering a useful human explanation.

Examples:

Bad:

```text
memory_claim_upsert_complete
```

Good:

> Proxy added this observation as evidence for an existing Memory.

Bad:

```text
duplicate_key constraint violated
```

Good:

> Proxy tried to save something that already existed. The duplicate was not added.

Then technical details can reveal the underlying database error.

Where possible, centralize event-to-human-language formatting.

---

# 20. Security and Privacy

Inspector General may expose very broad Proxy data.

Please respect existing authentication/RLS architecture.

Do not weaken RLS merely to make Inspector General easier to implement.

Do not expose:

* Supabase service-role keys
* API tokens
* auth tokens
* environment secrets
* credentials
* raw authorization headers

Raw model prompts/responses may contain sensitive information.

If exposing them at all, put them behind technical-detail expansion rather than default views.

Use existing visibility/privacy concepts in Memory where applicable.

---

# 21. Integration with Existing Memory Bug Fix

Inspector General should integrate naturally with the Memory claim reconciliation fix currently being implemented.

For claim reconciliation, record diagnostic outcomes such as:

* `new`
* `supports_existing`
* `duplicates_existing`
* `refines_existing`
* `contradicts_existing`
* `supersedes_existing`

For example:

```text
Observation:
Heather is working on the Grad Program Health Rubric.

Existing Memory:
Heather is leading development of the Graduate Program Portfolio Health Rubric.

Decision:
supports_existing

Why:
Equivalent core proposition; existing claim is user-confirmed.

Result:
Attached new evidence.
No review item created.
```

This case should become one of the first end-to-end Inspector General test traces.

---

# 22. Existing Data to Inspect

Before implementing schema or event architecture, inspect the actual current project.

Relevant existing tables likely include at least:

* `memory_source_families`
* `memory_sources`
* `memory_entities`
* `memory_entity_identifiers`
* `memory_evidence`
* `memory_evidence_entities`
* `memory_claims`
* `memory_claim_entities`
* `memory_claim_evidence`
* `memory_pending_context`
* `memory_review_items`
* Execute/task-related tables
* Mailroom tables
* calendar ingestion tables
* email ingestion tables
* existing processing/run tables
* any current logging/audit/run-history tables

Do not create parallel concepts unnecessarily.

Reuse existing run IDs, source IDs, entity IDs, and processing IDs where possible.

---

# 23. Architecture Goal: One Trace Language Across Proxy

Please avoid this outcome:

```text
Mailroom has one audit system
Memory has another
Execute has another
Documents have another
Calendar has another
```

Instead create one shared **Proxy diagnostic vocabulary**.

Each module should emit into the same trace/activity architecture.

A generic helper/API could conceptually support something like:

```ts
emitDiagnosticEvent({
  traceId,
  module: "memory",
  stage: "reconciled",
  status: "success",
  objectType: "memory_claim",
  objectId: claimId,
  humanSummary:
    "Proxy added this as evidence for something it already knew.",
  decisionType: "supports_existing",
  metadata: {...}
})
```

Exact implementation is up to you.

Prefer a clean common service/helper rather than scattered direct inserts.

---

# 24. Do Not Over-Instrument the UI

Do not instrument trivial React component events simply because they are easy to log.

Inspector General should describe meaningful Proxy behavior.

Good events:

* source received
* document parsed
* entity resolved
* candidate facts extracted
* Memory reconciled
* review created
* review suppressed
* task created
* task updated
* model call failed
* calendar sync completed
* source processing failed

Usually not useful:

* modal opened
* button hovered
* component mounted
* sidebar rendered

Performance instrumentation can separately measure significant page/navigation timings.

---

# 25. Initial End-to-End Test Scenarios

Please build automated tests where practical and manually verify representative traces.

At minimum test:

### Scenario A: Normal email

```text
email received
→ stored
→ parsed
→ entities recognized
→ Memory extraction
→ reconciliation
→ evidence/claim outcome
→ completed
```

Inspector General should show one coherent trace.

### Scenario B: Duplicate Memory observation

Existing confirmed Memory:

> Heather leads the Graduate Program Portfolio Health Rubric.

New email says substantially the same thing.

Expected:

```text
observation extracted
→ matched existing claim
→ supports_existing
→ evidence added
→ review suppressed
```

Inspector General should explain why.

### Scenario C: Duplicate source reprocessing

Same source re-run with a new ingestion version.

Expected:

```text
source recognized as previously processed
→ reprocessing mode
→ extraction reconciled
→ no duplicate review generated
```

### Scenario D: Document failure

Document arrives but text extraction fails.

Expected:

```text
source received
→ attachment obtained
→ parsing failed
→ Needs Attention created
```

User should be able to inspect and retry.

### Scenario E: Successful retry

Retry succeeds.

Expected:

```text
original failure retained historically
→ retry attempted
→ parsing succeeds
→ downstream processing resumes
→ Needs Attention resolved
```

### Scenario F: Entity ambiguity

Two possible people match.

Expected:

```text
entity resolution uncertain
→ Needs Attention
→ user resolves identity
→ trace resumes/updates
```

### Scenario G: Performance problem

Artificially slow query or operation.

Expected:

Inspector General highlights it as a meaningful slow operation without treating it as an ingestion failure.

---

# 26. Acceptance Criteria

Inspector General is successful when I can do the following without opening Supabase:

### Source debugging

Select an email/document/meeting and answer:

> Did Proxy actually receive and process this?

### Logic debugging

Select a Memory Review item and answer:

> Why did Proxy ask me this?

### Deduplication debugging

Select a claim and answer:

> Did Proxy see this same fact elsewhere, and what did it do with those observations?

### Failure debugging

Answer:

> What is currently broken or stalled?

### Retry

Retry a recoverable ingestion failure and see whether it succeeded.

### Entity debugging

Answer:

> Why did Proxy think this source referred to this person/project?

### Action debugging

Answer:

> Why did this become a task or not become a task?

### Performance debugging

Answer:

> Why does this screen feel slow?

### Technical escalation

When necessary, expand a record far enough that a developer can identify:

* source ID
* trace ID
* object IDs
* processing version
* model/version
* timing
* error code
* structured metadata

without requiring those details to pollute the normal interface.

---

# 27. UI Quality Standard

Inspector General should feel like a polished part of Proxy, not an admin dashboard template.

Priorities:

* high information density without visual clutter
* compact typography
* clear hierarchy
* strong use of whitespace
* status icons used consistently
* expandable details rather than enormous cards
* side drawers/details for deeper inspection
* persistent search/filtering where useful
* avoid excessive nested cards
* avoid giant empty whitespace
* avoid giant technical tables as the main UI
* avoid dashboards consisting primarily of decorative charts

The best mental model is:

> **Activity log + investigative trace + system-health monitor**

rather than:

> **enterprise analytics dashboard**

---

# 28. Build Sequence

Please approach implementation in roughly this order unless the existing codebase suggests a better dependency order:

1. Inspect current ingestion, Memory, Execute, Mailroom, logging, and run-history architecture.
2. Define shared diagnostic event/trace concepts.
3. Add any minimal necessary schema.
4. Create the shared instrumentation/service layer.
5. Instrument one complete ingestion path end-to-end, preferably email → Memory.
6. Build the basic Inspector General screen against real diagnostic data.
7. Add Trace detail UI.
8. Add Needs Attention / retry behavior.
9. Add Memory-specific diagnostics.
10. Add Performance instrumentation.
11. Extend diagnostic instrumentation to calendar/documents/meeting notes/Execute where existing code supports it.
12. Add contextual `Trace` / `Why?` entry points.
13. Add tests and regression scenarios.
14. Run the app in both development and production mode and verify Inspector General does not materially degrade performance.

Do not attempt to fake unsupported downstream modules merely to make the Inspector General screen appear complete. Real partial coverage is preferable to mocked completeness.

---

# 29. Final Deliverable

After implementing, give me a concise implementation report covering:

### Architecture

* tables/schema added or changed
* trace/event model
* shared diagnostic helper/service
* retention decisions

### Instrumented pipelines

List which existing Proxy flows currently emit traces.

### User experience

Describe:

* Inspector General landing page
* System Health
* Needs Attention
* Activity
* Trace
* Memory diagnostics
* Performance

### Retry behavior

Explain what types of failures can currently be retried and how downstream processing resumes.

### Memory integration

Show one real trace illustrating a candidate observation being reconciled against an existing confirmed claim.

### Known gaps

Be explicit about Proxy areas that are not yet fully instrumented.

### Verification

Run:

* relevant unit/integration tests
* TypeScript checks
* linting where configured
* production build

Fix regressions introduced by this work.

The key success condition is not merely that Proxy now has logs.

It is that a non-technical person can open **Inspector General**, inspect strange Proxy behavior, and understand:

> **what happened, why it happened, whether it was correct, and where the system failed if it was not.**
