import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";
import { ensureExecuteWorkspace } from "./ensureWorkspace";
import { getSurfaceMapping } from "./mapping";
import {
  checkboxProperty,
  dateProperty,
  emptyCounts,
  numberProperty,
  relationProperty,
  richTextProperty,
  selectProperty,
  syncOne,
  titleProperty,
  urlProperty,
  type ObjectSyncCounts,
  type SyncError,
} from "./pageSync";
import { resolveProjectTitle } from "@/lib/execute/projects";
import type { NotionWorkspaceDatabaseKey } from "./types";

type PriorityDirectiveRow = {
  tier?: string;
  why?: string;
  desiredOutcome?: string;
  timing?: { at?: string; kind?: string };
  protection?: string;
  attentionPriority?: string;
  reassessAt?: string;
} | null;

type ExecuteProjectRow = {
  id: string;
  memory_project_entity_id: string | null;
  status: string;
  next_plateau: string | null;
  title: string | null;
  description: string | null;
  desired_outcome: string | null;
  why_it_matters: string | null;
  target_date: string | null;
  priority_directive: PriorityDirectiveRow;
  memory_entities: { canonical_name: string } | null;
};

type ExecutionItemRow = {
  id: string;
  title: string;
  status: string;
  responsibility: string;
  effort_minutes: number | null;
  timing_at: string | null;
  timing_kind: string | null;
  critical_rank: number | null;
  waiting_since: string | null;
  expected_at: string | null;
  related_person_entity_id: string | null;
  obligation_context: string | null;
  project_state_id: string | null;
  priority_directive: PriorityDirectiveRow;
  curated: boolean;
  why_surfaced: string | null;
  why_suppressed: string | null;
  last_assessed_at: string | null;
  planned_at: string | null;
  source_system: string | null;
  source_ref: string | null;
  source_artifact_id: string | null;
  source_meeting_id: string | null;
};

type MilestoneRow = {
  id: string;
  project_state_id: string;
  title: string;
  description: string | null;
  target_date: string | null;
  status: string;
  achieved_at: string | null;
};

type MeetingRow = {
  event_id: string;
  subject: string | null;
  start_time: string | null;
  end_time: string | null;
  organizer: string | null;
  attendees: unknown;
  is_recurring: boolean | null;
  web_link: string | null;
};

type TouchpointRow = {
  calendar_event_id: string;
  project_state_id: string | null;
  milestone_id: string | null;
  desired_state: string | null;
  preparation_notes: string | null;
};

type WorkBlockRow = {
  id: string;
  title: string;
  status: string;
  planned_start: string;
  planned_end: string;
  completion_note: string | null;
  checklist: Array<{ label: string; checked: boolean }>;
  execute_work_block_items: Array<{ execution_item_id: string }>;
};

export type WorkspaceDatabaseStatus = {
  key: NotionWorkspaceDatabaseKey;
  status: "found" | "created" | "would_create";
  dataSourceId: string | null;
};

export type ExecuteSyncSummary = {
  dryRun: boolean;
  workspace: WorkspaceDatabaseStatus[];
  projects: ObjectSyncCounts;
  items: ObjectSyncCounts;
  milestones: ObjectSyncCounts;
  meetings: ObjectSyncCounts;
  workBlocks: ObjectSyncCounts;
  errors: SyncError[];
};

/**
 * Resolves the three Execute workspace databases. In apply mode this
 * creates whichever are missing (via ensureExecuteWorkspace). In dry-run
 * mode this only reads surface_objects -- no Notion or Supabase writes --
 * so a database that doesn't exist yet is reported as "would_create" with
 * no data source id, which is fine because dry run never builds a page
 * payload that would need one.
 */
async function resolveWorkspace(dryRun: boolean): Promise<{
  statuses: WorkspaceDatabaseStatus[];
  projectsDataSourceId: string | null;
  itemsDataSourceId: string | null;
  milestonesDataSourceId: string | null;
  meetingsDataSourceId: string | null;
  workBlocksDataSourceId: string | null;
}> {
  if (!dryRun) {
    const ds = await ensureExecuteWorkspace();
    return {
      statuses: [
        { key: "execute_projects", status: "found", dataSourceId: ds.projectsDataSourceId },
        { key: "execute_items", status: "found", dataSourceId: ds.itemsDataSourceId },
        { key: "execute_milestones", status: "found", dataSourceId: ds.milestonesDataSourceId },
        { key: "execute_meetings", status: "found", dataSourceId: ds.meetingsDataSourceId },
        { key: "execute_work_blocks", status: "found", dataSourceId: ds.workBlocksDataSourceId },
      ],
      projectsDataSourceId: ds.projectsDataSourceId,
      itemsDataSourceId: ds.itemsDataSourceId,
      milestonesDataSourceId: ds.milestonesDataSourceId,
      meetingsDataSourceId: ds.meetingsDataSourceId,
      workBlocksDataSourceId: ds.workBlocksDataSourceId,
    };
  }

  const [projects, items, milestones, meetings, workBlocks] = await Promise.all([
    getSurfaceMapping("notion_workspace_database", "execute_projects"),
    getSurfaceMapping("notion_workspace_database", "execute_items"),
    getSurfaceMapping("notion_workspace_database", "execute_milestones"),
    getSurfaceMapping("notion_workspace_database", "execute_meetings"),
    getSurfaceMapping("notion_workspace_database", "execute_work_blocks"),
  ]);

  const toStatus = (
    key: NotionWorkspaceDatabaseKey,
    mapping: { externalObjectId: string | null } | null
  ): WorkspaceDatabaseStatus => ({
    key,
    status: mapping?.externalObjectId ? "found" : "would_create",
    dataSourceId: mapping?.externalObjectId ?? null,
  });

  return {
    statuses: [
      toStatus("execute_projects", projects),
      toStatus("execute_items", items),
      toStatus("execute_milestones", milestones),
      toStatus("execute_meetings", meetings),
      toStatus("execute_work_blocks", workBlocks),
    ],
    projectsDataSourceId: projects?.externalObjectId ?? null,
    itemsDataSourceId: items?.externalObjectId ?? null,
    milestonesDataSourceId: milestones?.externalObjectId ?? null,
    meetingsDataSourceId: meetings?.externalObjectId ?? null,
    workBlocksDataSourceId: workBlocks?.externalObjectId ?? null,
  };
}

async function syncProjects(
  dataSourceId: string | null,
  dryRun: boolean,
  traceId: string | null
): Promise<{ counts: ObjectSyncCounts; errors: SyncError[] }> {
  const counts = emptyCounts();
  const errors: SyncError[] = [];

  /*
   * LEFT join, not inner: a Project no longer requires a Memory project
   * entity. The previous !inner join would have silently dropped every
   * project created directly in Execute or in Notion.
   *
   * The FK is named explicitly because owner_entity_id gives this table a
   * second reference to memory_entities, and an unqualified embed is then
   * ambiguous to PostgREST.
   */
  const { data, error } = await supabaseServer
    .from("execute_project_states")
    .select(
      "id, memory_project_entity_id, status, next_plateau, title, description, desired_outcome, why_it_matters, target_date, priority_directive, memory_entities!execute_project_states_memory_project_entity_id_fkey(canonical_name)"
    )
    .returns<ExecuteProjectRow[]>();

  if (error) {
    throw new Error(`Failed to load execute_project_states: ${error.message}`);
  }

  for (const row of data ?? []) {
    const canonicalFields = {
      name: resolveProjectTitle(row),
      status: row.status,
      nextPlateau: row.next_plateau,
      description: row.description,
      whyItMatters: row.why_it_matters,
      targetDate: row.target_date,
      tier: row.priority_directive?.tier ?? null,
      why: row.priority_directive?.why ?? null,
      /*
       * The project's own desired outcome is the durable, human-authored
       * one. priority_directive.desiredOutcome is the Chief of Staff's
       * current framing of it and only fills in when the project has no
       * answer of its own -- CoS decides what matters, the project owns what
       * it is.
       */
      desiredOutcome: row.desired_outcome ?? row.priority_directive?.desiredOutcome ?? null,
      timingAt: row.priority_directive?.timing?.at ?? null,
      protection: row.priority_directive?.protection ?? null,
      attentionPriority: row.priority_directive?.attentionPriority ?? null,
      reassessAt: row.priority_directive?.reassessAt ?? null,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "execute_project",
      objectId: row.id,
      dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Name: titleProperty(canonicalFields.name || "Untitled project"),
        "Priority Tier": selectProperty(canonicalFields.tier),
        "Priority Why": richTextProperty(canonicalFields.why),
        "Next Plateau": richTextProperty(canonicalFields.nextPlateau),
        "Desired Outcome": richTextProperty(canonicalFields.desiredOutcome),
        Description: richTextProperty(canonicalFields.description),
        "Why It Matters": richTextProperty(canonicalFields.whyItMatters),
        "Target Date": dateProperty(canonicalFields.targetDate),
        Timing: dateProperty(canonicalFields.timingAt),
        Protection: selectProperty(canonicalFields.protection),
        "Attention Priority": selectProperty(canonicalFields.attentionPriority),
        "Reassess At": dateProperty(canonicalFields.reassessAt),
        Status: selectProperty(canonicalFields.status),
        "Proxy ID": richTextProperty(row.id),
      }),
      /*
       * These are the fields Dave edits on a project page, and pullExecute.ts
       * reads them back into Supabase. Guarding them means a sweep that runs
       * between his edit and the next pull leaves the edit alone instead of
       * overwriting it with stale canonical state.
       */
      guardedProperties: [
        "Name",
        "Description",
        "Desired Outcome",
        "Why It Matters",
        "Target Date",
        "Next Plateau",
        "Status",
      ],
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "execute_project", objectId: row.id, message: "See diagnostics." });
  }

  return { counts, errors };
}

async function syncItems(
  dataSourceId: string | null,
  dryRun: boolean,
  traceId: string | null
): Promise<{ counts: ObjectSyncCounts; errors: SyncError[] }> {
  const counts = emptyCounts();
  const errors: SyncError[] = [];

  const { data, error } = await supabaseServer
    .from("execution_items")
    .select(
      "id, title, status, responsibility, effort_minutes, timing_at, timing_kind, critical_rank, waiting_since, expected_at, related_person_entity_id, obligation_context, project_state_id, priority_directive, curated, why_surfaced, why_suppressed, last_assessed_at, planned_at, source_system, source_ref, source_artifact_id, source_meeting_id"
    )
    .returns<ExecutionItemRow[]>();

  if (error) {
    throw new Error(`Failed to load execution_items: ${error.message}`);
  }

  const rows = data ?? [];
  const relatedPersonIds = [...new Set(rows.map((row) => row.related_person_entity_id).filter((id): id is string => Boolean(id)))];
  const { data: relatedPeople, error: relatedPeopleError } = relatedPersonIds.length
    ? await supabaseServer.from("memory_entities").select("id, canonical_name").in("id", relatedPersonIds)
    : { data: [] as { id: string; canonical_name: string }[], error: null };
  if (relatedPeopleError) throw new Error(`Failed to load related people: ${relatedPeopleError.message}`);
  const relatedPersonNames = new Map((relatedPeople ?? []).map((person) => [person.id, person.canonical_name]));

  for (const row of rows) {
    const projectMapping = row.project_state_id
      ? await getSurfaceMapping("execute_project", row.project_state_id)
      : null;

    const canonicalFields = {
      title: row.title,
      status: row.status,
      responsibility: row.responsibility,
      effortMinutes: row.effort_minutes,
      timingAt: row.timing_at,
      timingKind: row.timing_kind,
      criticalRank: row.critical_rank,
      waitingSince: row.waiting_since,
      expectedAt: row.expected_at,
      waitingOn: row.related_person_entity_id ? relatedPersonNames.get(row.related_person_entity_id) ?? null : null,
      obligationContext: row.obligation_context,
      projectPageId: projectMapping?.externalObjectId ?? null,
      tier: row.priority_directive?.tier ?? null,
      why: row.priority_directive?.why ?? null,
      protection: row.priority_directive?.protection ?? null,
      attentionPriority: row.priority_directive?.attentionPriority ?? null,
      reassessAt: row.priority_directive?.reassessAt ?? null,
      curated: row.curated,
      whySurfaced: row.why_surfaced,
      whySuppressed: row.why_suppressed,
      lastAssessedAt: row.last_assessed_at,
      plannedAt: row.planned_at,
      source: row.source_system,
      sourceRef: row.source_ref ?? row.source_artifact_id ?? row.source_meeting_id ?? null,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "execute_item",
      objectId: row.id,
      dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Title: titleProperty(canonicalFields.title),
        Project: relationProperty(canonicalFields.projectPageId),
        Status: selectProperty(canonicalFields.status),
        Responsibility: selectProperty(canonicalFields.responsibility),
        "Estimated Effort (min)": numberProperty(canonicalFields.effortMinutes),
        Timing: dateProperty(canonicalFields.timingAt),
        "Timing Kind": selectProperty(canonicalFields.timingKind),
        "Critical Rank": numberProperty(canonicalFields.criticalRank),
        "Waiting Since": dateProperty(canonicalFields.waitingSince),
        "Waiting On": richTextProperty(canonicalFields.waitingOn),
        "Expected At": dateProperty(canonicalFields.expectedAt),
        "Next Action / Context": richTextProperty(canonicalFields.obligationContext),
        "Priority Tier": selectProperty(canonicalFields.tier),
        "Priority Why": richTextProperty(canonicalFields.why),
        Protection: selectProperty(canonicalFields.protection),
        "Attention Priority": selectProperty(canonicalFields.attentionPriority),
        "Reassess At": dateProperty(canonicalFields.reassessAt),
        "Curated?": checkboxProperty(canonicalFields.curated),
        "Why Surfaced": richTextProperty(canonicalFields.whySurfaced),
        "Why Suppressed": richTextProperty(canonicalFields.whySuppressed),
        "Last Assessed": dateProperty(canonicalFields.lastAssessedAt),
        "Planned Date": dateProperty(canonicalFields.plannedAt),
        Source: selectProperty(canonicalFields.source),
        "Source Ref": richTextProperty(canonicalFields.sourceRef),
        "Proxy ID": richTextProperty(row.id),
      }),
      /*
       * "Planned Date" and "Project" are the two fields Notion owns for an
       * item: Dave drags the first around a calendar and sets the second by
       * filing work under a project, and pullExecute.ts reads both back.
       * Guarding them stops a sweep landing between his edit and the next
       * pull from reverting what he just did.
       */
      guardedProperties: ["Planned Date", "Project"],
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "execute_item", objectId: row.id, message: "See diagnostics." });
  }

  return { counts, errors };
}

/**
 * MILESTONES: durable accomplishments inside a project. Pushed as their own
 * pages so a project can carry several over time, and so a plateau on a
 * meeting can point at one.
 */
async function syncMilestones(
  dataSourceId: string | null,
  dryRun: boolean,
  traceId: string | null
): Promise<{ counts: ObjectSyncCounts; errors: SyncError[] }> {
  const counts = emptyCounts();
  const errors: SyncError[] = [];

  const { data, error } = await supabaseServer
    .from("execute_milestones")
    .select("id, project_state_id, title, description, target_date, status, achieved_at")
    .returns<MilestoneRow[]>();

  if (error) {
    throw new Error(`Failed to load execute_milestones: ${error.message}`);
  }

  for (const row of data ?? []) {
    const projectMapping = await getSurfaceMapping("execute_project", row.project_state_id);

    const canonicalFields = {
      title: row.title,
      status: row.status,
      targetDate: row.target_date,
      description: row.description,
      achievedAt: row.achieved_at,
      projectPageId: projectMapping?.externalObjectId ?? null,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "execute_milestone",
      objectId: row.id,
      dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Name: titleProperty(canonicalFields.title),
        Project: relationProperty(canonicalFields.projectPageId),
        Status: selectProperty(canonicalFields.status),
        "Target Date": dateProperty(canonicalFields.targetDate),
        Description: richTextProperty(canonicalFields.description),
        "Achieved At": dateProperty(canonicalFields.achievedAt),
        "Proxy ID": richTextProperty(row.id),
      }),
      guardedProperties: ["Name", "Status", "Target Date", "Description"],
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "execute_milestone", objectId: row.id, message: "See diagnostics." });
  }

  return { counts, errors };
}

/**
 * How far around today meetings are projected into Notion. Outlook holds 256
 * events and most are history; a working surface wants the ones Dave can
 * still prepare for, plus enough of the recent past to attach a plateau
 * retrospectively.
 */
const MEETING_PAST_DAYS = 14;
const MEETING_FUTURE_DAYS = 60;

/**
 * MEETINGS: canonical Outlook events, plus Proxy-owned enrichment.
 *
 * The canonical half (subject/when/organizer/attendees/recurrence/link/id) is
 * projected read-only from calendar_events and is never read back from
 * Notion -- nothing in this codebase can write an Outlook-owned field from a
 * Notion edit, because the pull path only ever writes execute_touchpoints.
 *
 * The enrichment half (project, milestone, plateau, prep notes) is guarded on
 * push and pulled back on the next pull, so Dave attaching a project and a
 * required plateau to Thursday's review changes Proxy's understanding of the
 * meeting without touching the meeting itself.
 */
async function syncMeetings(
  dataSourceId: string | null,
  dryRun: boolean,
  traceId: string | null
): Promise<{ counts: ObjectSyncCounts; errors: SyncError[] }> {
  const counts = emptyCounts();
  const errors: SyncError[] = [];

  const now = new Date();
  const from = new Date(now.getTime() - MEETING_PAST_DAYS * 86_400_000).toISOString();
  const to = new Date(now.getTime() + MEETING_FUTURE_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabaseServer
    .from("calendar_events")
    .select("event_id, subject, start_time, end_time, organizer, attendees, is_recurring, web_link")
    .gte("start_time", from)
    .lte("start_time", to)
    .order("start_time")
    .returns<MeetingRow[]>();

  if (error) {
    throw new Error(`Failed to load calendar_events: ${error.message}`);
  }

  const rows = data ?? [];
  if (!rows.length) return { counts, errors };

  /*
   * Every touchpoint, filtered in memory rather than with .in(event ids).
   * Outlook event ids are ~150 characters and PostgREST puts `in.(...)` in
   * the query string, so a window of meetings builds a URL long enough to
   * come back as a flat "Bad Request". The table holds one row per meeting
   * Dave has actually enriched, so reading it whole is cheaper than the
   * filter would have been anyway.
   */
  const { data: touchpoints, error: touchpointError } = await supabaseServer
    .from("execute_touchpoints")
    .select("calendar_event_id, project_state_id, milestone_id, desired_state, preparation_notes")
    .returns<TouchpointRow[]>();

  if (touchpointError) {
    throw new Error(`Failed to load execute_touchpoints: ${touchpointError.message}`);
  }

  const enrichment = new Map((touchpoints ?? []).map((row) => [row.calendar_event_id, row]));

  for (const row of rows) {
    const touchpoint = enrichment.get(row.event_id) ?? null;
    const projectMapping = touchpoint?.project_state_id
      ? await getSurfaceMapping("execute_project", touchpoint.project_state_id)
      : null;
    const milestoneMapping = touchpoint?.milestone_id
      ? await getSurfaceMapping("execute_milestone", touchpoint.milestone_id)
      : null;

    const attendees = Array.isArray(row.attendees) ? row.attendees : [];
    const attendeeNames = attendees
      .map((attendee) => {
        if (typeof attendee === "string") return attendee;
        const record = attendee as { name?: string; emailAddress?: { name?: string; address?: string } };
        return record.name ?? record.emailAddress?.name ?? record.emailAddress?.address ?? null;
      })
      .filter((name): name is string => Boolean(name));

    const canonicalFields = {
      subject: row.subject ?? "Untitled meeting",
      start: row.start_time,
      end: row.end_time,
      organizer: row.organizer,
      attendees: attendeeNames.join(", ") || null,
      recurring: row.is_recurring === true,
      link: row.web_link,
      projectPageId: projectMapping?.externalObjectId ?? null,
      milestonePageId: milestoneMapping?.externalObjectId ?? null,
      plateau: touchpoint?.desired_state ?? null,
      preparationNotes: touchpoint?.preparation_notes ?? null,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "calendar_event",
      objectId: row.event_id,
      dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Meeting: titleProperty(canonicalFields.subject),
        When: {
          type: "date" as const,
          date: canonicalFields.start ? { start: canonicalFields.start, end: canonicalFields.end } : null,
        },
        Organizer: richTextProperty(canonicalFields.organizer),
        Attendees: richTextProperty(canonicalFields.attendees),
        Recurring: checkboxProperty(canonicalFields.recurring),
        "Related Project": relationProperty(canonicalFields.projectPageId),
        "Related Milestone": relationProperty(canonicalFields.milestonePageId),
        "Plateau Required": richTextProperty(canonicalFields.plateau),
        "Preparation Notes": richTextProperty(canonicalFields.preparationNotes),
        "Outlook Event ID": richTextProperty(row.event_id),
        Link: urlProperty(canonicalFields.link),
      }),
      guardedProperties: ["Related Project", "Related Milestone", "Plateau Required", "Preparation Notes"],
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "calendar_event", objectId: row.event_id, message: "See diagnostics." });
  }

  return { counts, errors };
}

async function syncWorkBlocks(
  dataSourceId: string | null,
  dryRun: boolean,
  traceId: string | null
): Promise<{ counts: ObjectSyncCounts; errors: SyncError[] }> {
  const counts = emptyCounts();
  const errors: SyncError[] = [];

  const { data, error } = await supabaseServer
    .from("execute_work_blocks")
    .select(
      "id, title, status, planned_start, planned_end, completion_note, checklist, execute_work_block_items(execution_item_id)"
    )
    .returns<WorkBlockRow[]>();

  if (error) {
    throw new Error(`Failed to load execute_work_blocks: ${error.message}`);
  }

  for (const row of data ?? []) {
    const linkedItemPageIds: string[] = [];
    for (const link of row.execute_work_block_items ?? []) {
      const itemMapping = await getSurfaceMapping("execute_item", link.execution_item_id);
      if (itemMapping?.externalObjectId) {
        linkedItemPageIds.push(itemMapping.externalObjectId);
      }
    }

    const canonicalFields = {
      title: row.title,
      status: row.status,
      plannedStart: row.planned_start,
      plannedEnd: row.planned_end,
      completionNote: row.completion_note,
      checklist: row.checklist,
      linkedItemPageIds,
    };

    const action = await syncOne({
      dryRun,
      traceId,
      objectType: "execute_work_block",
      objectId: row.id,
      dataSourceId,
      canonicalFields,
      buildProperties: () => ({
        Title: titleProperty(canonicalFields.title),
        Type: selectProperty("work_block"),
        Scheduled: { type: "date" as const, date: { start: canonicalFields.plannedStart, end: canonicalFields.plannedEnd } },
        "Linked Execution Items": {
          type: "relation" as const,
          relation: linkedItemPageIds.map((id) => ({ id })),
        },
        Status: selectProperty(canonicalFields.status),
        "Completion Note": richTextProperty(canonicalFields.completionNote),
        "Proxy ID": richTextProperty(row.id),
      }),
      // Checklist is only seeded into page body as to-do blocks on first
      // creation (buildChildren only runs when there's no existing page to
      // update). Syncing edits back onto an existing page's blocks would
      // need block-level diffing, which is out of scope for this pass --
      // once a work block page exists, its checklist in Notion is the
      // human's source of truth for that page.
      buildChildren: () =>
        (row.checklist ?? []).map((item) => ({
          object: "block" as const,
          type: "to_do" as const,
          to_do: {
            rich_text: [{ type: "text" as const, text: { content: item.label } }],
            checked: item.checked,
          },
        })),
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "execute_work_block", objectId: row.id, message: "See diagnostics." });
  }

  return { counts, errors };
}

/**
 * Full projection of Execute's canonical Supabase state into Notion.
 * Idempotent: unchanged rows (by canonical_hash) are skipped, and every
 * create/update goes through the surface_objects mapping so re-running
 * never produces duplicate Notion pages. With dryRun:true, this makes no
 * Notion API calls and no Supabase writes -- it only reads current state
 * and reports what would happen.
 */
export async function syncExecuteToNotion(options: { dryRun: boolean; traceId: string | null }): Promise<ExecuteSyncSummary> {
  const { dryRun, traceId } = options;

  const workspace = await resolveWorkspace(dryRun);
  await emitDiagnosticEvent({
    traceId,
    module: "notion",
    stage: "sync_execute",
    eventType: "workspace_resolved",
    status: "success",
    humanSummary: dryRun ? "Checked Execute workspace databases (dry run)" : "Ensured Execute workspace databases",
    metadata: { statuses: workspace.statuses },
  });

  /*
   * Sequential, and in dependency order: milestones relate to project pages
   * and meetings relate to both, so each stage needs the previous stage's
   * surface_objects mappings to exist before it can resolve a relation
   * target.
   */
  const projects = await syncProjects(workspace.projectsDataSourceId, dryRun, traceId);
  const items = await syncItems(workspace.itemsDataSourceId, dryRun, traceId);
  const milestones = await syncMilestones(workspace.milestonesDataSourceId, dryRun, traceId);
  const meetings = await syncMeetings(workspace.meetingsDataSourceId, dryRun, traceId);
  const workBlocks = await syncWorkBlocks(workspace.workBlocksDataSourceId, dryRun, traceId);

  return {
    dryRun,
    workspace: workspace.statuses,
    projects: projects.counts,
    items: items.counts,
    milestones: milestones.counts,
    meetings: meetings.counts,
    workBlocks: workBlocks.counts,
    errors: [
      ...projects.errors,
      ...items.errors,
      ...milestones.errors,
      ...meetings.errors,
      ...workBlocks.errors,
    ],
  };
}
