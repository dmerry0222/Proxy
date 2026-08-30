# Proxy TODO

* [ ] **Complete Power Automate handling for attachments and meeting-related email.** Strip or transfer relevant attachments and meeting notes into Proxy’s ingestion pipeline; handle identifiable meeting-note messages appropriately; and automate calendar-invite acceptance where Proxy has permission to act.

* [ ] **Silly, but change to the government names**

## P1: Diagnostic and Observability Layer

* [ ] **Build a Proxy Diagnostic / System Health screen: inspector general** Provide a readable inventory of recent events, notes, documents, emails, meetings, people, projects, tasks, claims, pending context, Memory Review items, Execute items, agent actions, and failures.



## P1: Make Proxy Feel Fast

* [ ] **Audit navigation and rendering performance.** Compare `npm run dev` behavior with a production build and identify unnecessary compilation, rendering, fetching, or computation during navigation.

* [ ] **Keep the application shell persistent across screens.** Sidebar, navigation, layout, and other shared UI should remain mounted rather than rebuilding during routine route changes.

* [ ] **Cache previously visited primary screens.** Returning to Mailroom, Memory, Execute, or another primary module should immediately restore the last-known screen state and then refresh quietly in the background.

* [ ] **Separate navigation from intelligence.** Opening a screen should reveal previously computed state, not trigger expensive AI analysis. Intelligence should normally occur during ingestion or background processing and update stored state for the UI to display.

* [ ] **Use screen-specific and progressive data loading.** Load only the minimum data necessary to render the initial screen; fetch details, large evidence sets, documents, and related context only when the user requests them.

* [ ] **Add stale-while-revalidate behavior.** Show cached/current state immediately while checking Supabase for updates without replacing the entire screen with a loading state.

* [ ] **Virtualize or paginate large datasets.** Avoid rendering entire histories of Memory, calendar events, documents, tasks, or evidence when only a small visible subset is required.

* [ ] **Prefetch likely destinations when inexpensive.** During idle time, preload enough data for likely next screens to make ordinary navigation feel instantaneous.

---

## P1: Meetings and Execute Interaction

* [ ] **Make meetings first-class Proxy objects.** Resolve calendar events, invitations, notes, transcripts, attachments, related email, attendees, decisions, commitments, and follow-ups into a coherent meeting record.

* [ ] **Add a meeting detail side panel/drawer.** Keep the calendar visually dense, but make every meeting clickable. The detail view should expose attendees, body/agenda, related communication, meeting notes, extracted decisions, commitments, relevant Memory, related projects, and follow-up actions.

* [ ] **Make the Execute calendar genuinely interactive.** Users should be able to click meetings/tasks/projects rather than treating Execute as a static rendered calendar.

* [ ] **Add an Execute item detail panel.** Show what the item is, why it exists, current status, evidence/source, deadline, dependencies, project association, priority directive, calendar placement, and what Proxy proposes to do next.

* [ ] **Build a reliable commitment extractor.** Extract decisions, promises, deadlines, assignments, blockers, dependencies, and “waiting on” relationships from email and meeting notes and route them appropriately to Execute, Delegator, or Memory.

* [ ] **Deduplicate commitments across sources.** The same promise appearing in meeting notes, a transcript, a follow-up email, and a calendar note should result in one tracked commitment with multiple supporting sources.

---

## P1: Memory Calibration and Learning

* [ ] **Build a review-feedback learning loop.** Summarize confirmed, dismissed, corrected, outdated, and evidence-only review decisions into a compact, versioned preference profile, and supply that profile to future email, Teams, document, and meeting Memory extraction prompts. Keep the feedback inspectable and avoid treating it as model fine-tuning.

* [ ] **Teach Memory what is worth asking Dave about.** Use review history to reduce low-information confirmation questions, overly granular working-context claims, behavioral speculation from thin evidence, and facts that are technically true but not useful enough to retain.

* [ ] **Add lightweight correction controls throughout Proxy.** Support actions such as “wrong person,” “not a task,” “already done,” “belongs to Project X,” “remember this,” “don’t remember this,” “outdated,” and “surface later,” and ensure those corrections influence future processing.

* [ ] **Add “Why am I seeing this?” explanations.** For Memory Review, resurfaced context, reminders, Execute priorities, project associations, and CoS recommendations, expose the source/evidence and reasoning that caused Proxy to surface the item.

---

## P2: Chief of Staff and Agent Architecture

* [ ] **Define interaction rules and personas for Proxy's AI agents.** Document each agent's role, voice, authority, escalation behavior, memory access, tool permissions, handoff format, and relationship to Dave. Include shared rules for honesty, uncertainty, privacy, disagreement, interruption level, notification thresholds, and avoiding duplicated or contradictory outreach. Keep personas distinct enough to be useful while preserving one coherent understanding of Dave across agents.

* [ ] **Define an autonomy/permissions matrix.** For each agent and action type, explicitly determine whether Proxy may observe, suggest, act with confirmation, act autonomously and notify, or never act. Include high-frequency cases such as accepting meetings, archiving email, changing categories, scheduling work, creating tasks, modifying Memory, and contacting other people.

* [ ] **Implement the Chief of Staff → Execute priority directive.** Preserve the separation where Chief of Staff owns strategic priority and Execute owns feasibility, sequencing, and calendar placement. Include priority tier, rationale, desired outcome, timing, hardness, protection level, displacement permission, attention priority, reassessment date, and escalation conditions.

* [ ] **Create a Chief of Staff reconciliation pass.** Periodically compare calendar, projects, tasks, commitments, waiting-ons, recent Memory, and new incoming evidence to detect changed priorities, hidden obligations, emerging risks, overdue social commitments, and things that have fallen out of sight.

* [ ] **Prevent duplicate outreach across agents.** Establish shared coordination so Mailroom, Memory, Execute, Delegator, and Chief of Staff do not independently surface the same underlying issue to Dave.

---

## P2: Dave Profile and Explicit Learning

* [ ] **Create a structured interview protocol that helps Proxy learn about Dave over time.** Cover values, goals, responsibilities, relationships, projects, working style, decision-making, communication preferences, boundaries, recurring frustrations, and what a genuinely helpful Chief of Staff should notice. Make the interview resumable, avoid asking for facts Proxy already knows, distinguish durable truths from temporary context, and send proposed memories through review before treating them as established.

* [ ] **Create a canonical, human-readable `WHO_IS_DAVE.md` profile.** Generate it from confirmed Memory rather than unreviewed inference; include provenance and last-reviewed dates where useful; separate durable identity and preferences from current priorities; support direct correction by Dave; and define how database Memory and the file remain synchronized without either silently overwriting the other.

* [ ] **Separate enduring profile from current operating context.** Make sure durable preferences, roles, relationships, and values are not mixed indiscriminately with this week's projects, temporary frustrations, deadlines, or active priorities.

---

## P2: Daily and Mobile Experience

* [ ] **Design a compact mobile Memory Review experience.** Optimize for fast choice-based processing, minimal scrolling, easy defer/dismiss/correct actions, and occasional deeper drill-down rather than reproducing the desktop diagnostic interface.

* [ ] **Design a lightweight Chief of Staff check-in.** Surface a restrained number of genuinely useful observations: what changed, what needs attention, what might be slipping, what Proxy is waiting on, and what requires a decision.

* [ ] **Define information-density patterns across Proxy.** Use compact lists/calendars for scanning, side panels or drawers for detail, expandable provenance for evidence, and full pages only where sustained work is necessary. Avoid forcing all available context into the primary screen.

---

## P3: Longer-Term Refinement

* [ ] **Develop confidence and contradiction handling across Memory.** Allow multiple pieces of evidence to strengthen a proposition while explicitly representing conflicting or time-dependent evidence rather than collapsing everything into a single simplistic fact.

* [ ] **Improve temporal Memory.** Distinguish “currently true,” “used to be true,” “expected to become true,” “waiting for confirmation,” and “reassess after X date” so project roles, organizational changes, plans, and commitments evolve cleanly over time.

* [ ] **Build project-level Memory aggregation.** Allow Proxy to understand a project as a coherent object with goals, people, decisions, meetings, documents, tasks, milestones, risks, open questions, and history rather than merely a tag attached to unrelated claims.

* [ ] **Create regression metrics for Memory quality.** Track review acceptance/dismissal rates, duplicate-suppression rates, claims per source, reviews per source, corrections, stale claims, unresolved contradictions, and the proportion of extracted evidence that generates unnecessary user attention.

* [ ] **Create a “Proxy knows / Proxy thinks / Proxy needs to ask” distinction throughout the product.** Visually and architecturally separate confirmed state, model inference, pending context, and questions requiring human judgment.
