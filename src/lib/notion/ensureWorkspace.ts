import "server-only";

import { getProxyParentPageId, notionClient } from "./client";
import {
  EXECUTE_PROJECTS_PROPERTIES,
  executeItemsProperties,
  executeMeetingsProperties,
  executeMilestonesProperties,
  executeWorkBlocksProperties,
  type DataSourcePropertySchema,
} from "./executeSchema";
import { EXECUTE_VIEWS, ensureViews } from "./executeViews";
import { MAILROOM_PROPERTIES } from "./mailroomSchema";
import { ensureSurfaceMapping, markPushed, updateMappingMetadata } from "./mapping";
import type { NotionWorkspaceDatabaseKey, NotionWorkspaceDatabaseMetadata } from "./types";

type WorkspaceDatabaseSpec = {
  key: NotionWorkspaceDatabaseKey;
  title: string;
};

/**
 * Idempotently ensures one workspace-level Notion database exists under the
 * Proxy parent page, tracked via a surface_objects row keyed by `key` (there
 * is exactly one of each, so the key IS the proxy_object_id -- no generated
 * UUID). If a mapping already exists we trust it and return the stored data
 * source id without re-creating anything; Notion has no reliable
 * "find database I created before" lookup otherwise.
 */
async function ensureWorkspaceDatabase(
  spec: WorkspaceDatabaseSpec,
  buildProperties: () => DataSourcePropertySchema
): Promise<string> {
  const mapping = await ensureSurfaceMapping("notion_workspace_database", spec.key);

  if (mapping.externalObjectId) {
    // Schema can grow after the database was first created (e.g. Phase 6
    // added priority-directive fields with no prior Notion representation)
    // -- patch in whatever properties are missing. Notion's data source
    // update only adds/changes the properties you name here; it doesn't
    // remove ones you omit, so this is safe to call on every run. Best
    // effort: a schema-patch failure shouldn't block the page sync that
    // follows.
    try {
      await notionClient.dataSources.update({
        data_source_id: mapping.externalObjectId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: buildProperties() as any,
      });
    } catch (error) {
      console.error(`Could not patch Notion schema for "${spec.key}":`, error);
    }

    await ensureDatabaseViews(spec.key, mapping.id, mapping.externalObjectId, mapping.metadata);
    return mapping.externalObjectId;
  }

  const database = await notionClient.databases.create({
    parent: { type: "page_id", page_id: getProxyParentPageId() },
    title: [{ type: "text", text: { content: spec.title } }],
    initial_data_source: { properties: buildProperties() },
  });

  if (!("data_sources" in database) || database.data_sources.length === 0) {
    throw new Error(`Notion did not return a data source for database "${spec.title}"`);
  }

  const dataSourceId = database.data_sources[0].id;
  const metadata: NotionWorkspaceDatabaseMetadata = {
    databaseId: database.id,
    dataSourceId,
  };

  await markPushed(mapping.id, {
    externalObjectId: dataSourceId,
    canonicalHash: spec.key,
    metadata,
  });

  await ensureDatabaseViews(spec.key, mapping.id, dataSourceId, metadata as unknown as Record<string, unknown>);

  return dataSourceId;
}

/**
 * Seeds the human-facing views for one workspace database (Curated Execute,
 * All Execution Items, the planning calendar, ...) and records their ids on
 * the mapping so later sweeps skip them without any Notion calls.
 *
 * Never fatal: views are how the data is looked at, not what the data is, so
 * a failure here is logged and the page projection continues.
 */
async function ensureDatabaseViews(
  key: NotionWorkspaceDatabaseKey,
  mappingId: string,
  dataSourceId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const specs = EXECUTE_VIEWS[key];
  if (!specs?.length) return;

  const existing = (metadata?.views as Record<string, string> | undefined) ?? {};
  if (specs.every((spec) => existing[spec.name])) return;

  const databaseId = typeof metadata?.databaseId === "string" ? metadata.databaseId : null;
  if (!databaseId) {
    console.error(`Cannot create Notion views for "${key}": no databaseId recorded on the mapping.`);
    return;
  }

  try {
    const result = await ensureViews({ databaseId, dataSourceId, specs, existing });

    for (const failure of result.failed) {
      console.error(`Could not create Notion view "${failure.name}" on ${key}: ${failure.message}`);
    }

    if (Object.keys(result.created).length === 0) return;

    await updateMappingMetadata(mappingId, {
      ...metadata,
      views: { ...existing, ...result.created },
    });
  } catch (error) {
    console.error(`Could not ensure Notion views for "${key}":`, error);
  }
}

export type ExecuteWorkspaceDataSources = {
  projectsDataSourceId: string;
  itemsDataSourceId: string;
  milestonesDataSourceId: string;
  meetingsDataSourceId: string;
  workBlocksDataSourceId: string;
};

/**
 * Ensures the five Execute databases (Projects, Execution Items, Milestones,
 * Meetings, Work Blocks) exist under the Proxy parent page, creating whichever
 * are missing, and seeds their views. Safe to call on every sync run -- after
 * the first successful run this is just five surface_objects lookups and no
 * Notion API calls, because both the schema patch and the view seeding are
 * skipped once everything is present.
 *
 * Order matters: Milestones relates to Projects, and Meetings relates to both.
 */
export async function ensureExecuteWorkspace(): Promise<ExecuteWorkspaceDataSources> {
  const projectsDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_projects", title: "Execute – Projects" },
    () => EXECUTE_PROJECTS_PROPERTIES
  );

  const itemsDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_items", title: "Execute – Execution Items" },
    () => executeItemsProperties(projectsDataSourceId)
  );

  const milestonesDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_milestones", title: "Execute – Milestones" },
    () => executeMilestonesProperties(projectsDataSourceId)
  );

  const meetingsDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_meetings", title: "Execute – Meetings" },
    () => executeMeetingsProperties(projectsDataSourceId, milestonesDataSourceId)
  );

  const workBlocksDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_work_blocks", title: "Execute – Work Blocks" },
    () => executeWorkBlocksProperties(projectsDataSourceId, itemsDataSourceId)
  );

  return {
    projectsDataSourceId,
    itemsDataSourceId,
    milestonesDataSourceId,
    meetingsDataSourceId,
    workBlocksDataSourceId,
  };
}

/**
 * Ensures the single Mailroom conversations database exists under the
 * Proxy parent page. Independent of the Execute databases (no relations
 * between them), so it can be created on its own.
 */
export async function ensureMailroomWorkspace(): Promise<{ conversationsDataSourceId: string }> {
  const conversationsDataSourceId = await ensureWorkspaceDatabase(
    { key: "mailroom_conversations", title: "Mailroom" },
    () => MAILROOM_PROPERTIES
  );

  return { conversationsDataSourceId };
}
