import "server-only";

import { getProxyParentPageId, notionClient } from "./client";
import {
  EXECUTE_PROJECTS_PROPERTIES,
  executeItemsProperties,
  executeWorkBlocksProperties,
  type DataSourcePropertySchema,
} from "./executeSchema";
import { MAILROOM_PROPERTIES } from "./mailroomSchema";
import { ensureSurfaceMapping, markPushed } from "./mapping";
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

  return dataSourceId;
}

export type ExecuteWorkspaceDataSources = {
  projectsDataSourceId: string;
  itemsDataSourceId: string;
  workBlocksDataSourceId: string;
};

/**
 * Ensures the three Execute databases (Projects, Execution Items, Work
 * Blocks) exist under the Proxy parent page, creating whichever are
 * missing. Safe to call on every sync run -- after the first successful
 * run this is just three surface_objects lookups, no Notion API calls.
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

  const workBlocksDataSourceId = await ensureWorkspaceDatabase(
    { key: "execute_work_blocks", title: "Execute – Work Blocks" },
    () => executeWorkBlocksProperties(projectsDataSourceId, itemsDataSourceId)
  );

  return { projectsDataSourceId, itemsDataSourceId, workBlocksDataSourceId };
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
