import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";
import { ensureExecuteWorkspace } from "./ensureWorkspace";
import { getSurfaceMapping } from "./mapping";
import {
  dateProperty,
  emptyCounts,
  numberProperty,
  relationProperty,
  richTextProperty,
  selectProperty,
  syncOne,
  titleProperty,
  type ObjectSyncCounts,
  type SyncError,
} from "./pageSync";
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
  memory_project_entity_id: string;
  status: string;
  next_plateau: string | null;
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
  workBlocksDataSourceId: string | null;
}> {
  if (!dryRun) {
    const ds = await ensureExecuteWorkspace();
    return {
      statuses: [
        { key: "execute_projects", status: "found", dataSourceId: ds.projectsDataSourceId },
        { key: "execute_items", status: "found", dataSourceId: ds.itemsDataSourceId },
        { key: "execute_work_blocks", status: "found", dataSourceId: ds.workBlocksDataSourceId },
      ],
      projectsDataSourceId: ds.projectsDataSourceId,
      itemsDataSourceId: ds.itemsDataSourceId,
      workBlocksDataSourceId: ds.workBlocksDataSourceId,
    };
  }

  const [projects, items, workBlocks] = await Promise.all([
    getSurfaceMapping("notion_workspace_database", "execute_projects"),
    getSurfaceMapping("notion_workspace_database", "execute_items"),
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
      toStatus("execute_work_blocks", workBlocks),
    ],
    projectsDataSourceId: projects?.externalObjectId ?? null,
    itemsDataSourceId: items?.externalObjectId ?? null,
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

  const { data, error } = await supabaseServer
    .from("execute_project_states")
    .select("id, memory_project_entity_id, status, next_plateau, priority_directive, memory_entities!inner(canonical_name)")
    .returns<ExecuteProjectRow[]>();

  if (error) {
    throw new Error(`Failed to load execute_project_states: ${error.message}`);
  }

  for (const row of data ?? []) {
    const canonicalFields = {
      name: row.memory_entities?.canonical_name ?? "",
      status: row.status,
      nextPlateau: row.next_plateau,
      tier: row.priority_directive?.tier ?? null,
      why: row.priority_directive?.why ?? null,
      desiredOutcome: row.priority_directive?.desiredOutcome ?? null,
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
        Timing: dateProperty(canonicalFields.timingAt),
        Protection: selectProperty(canonicalFields.protection),
        "Attention Priority": selectProperty(canonicalFields.attentionPriority),
        "Reassess At": dateProperty(canonicalFields.reassessAt),
        Status: selectProperty(canonicalFields.status),
      }),
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
      "id, title, status, responsibility, effort_minutes, timing_at, timing_kind, critical_rank, waiting_since, expected_at, related_person_entity_id, obligation_context, project_state_id, priority_directive"
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
        "Proxy ID": richTextProperty(row.id),
      }),
    });

    counts[action] += 1;
    if (action === "error") errors.push({ objectType: "execute_item", objectId: row.id, message: "See diagnostics." });
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

  const [projects, items, workBlocks] = [
    await syncProjects(workspace.projectsDataSourceId, dryRun, traceId),
    await syncItems(workspace.itemsDataSourceId, dryRun, traceId),
    await syncWorkBlocks(workspace.workBlocksDataSourceId, dryRun, traceId),
  ];

  return {
    dryRun,
    workspace: workspace.statuses,
    projects: projects.counts,
    items: items.counts,
    workBlocks: workBlocks.counts,
    errors: [...projects.errors, ...items.errors, ...workBlocks.errors],
  };
}
