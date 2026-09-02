/**
 * Object types this adapter knows how to project into Notion. `object_type`
 * on surface_objects rows is always one of these.
 */
export type SurfaceObjectType =
  | "notion_workspace_database"
  | "execute_project"
  | "execute_item"
  | "execute_milestone"
  | "execute_work_block"
  | "mailroom_conversation"
  | "calendar_event";

/**
 * Fixed keys for the workspace-level databases this adapter maintains under
 * the Proxy parent page. Used as the `proxy_object_id` on
 * `notion_workspace_database` surface_objects rows -- there is exactly one
 * of each, so no generated UUID is needed.
 */
export type NotionWorkspaceDatabaseKey =
  | "execute_projects"
  | "execute_items"
  | "execute_milestones"
  | "execute_meetings"
  | "execute_work_blocks"
  | "mailroom_conversations";

export type SurfaceSyncStatus = "pending" | "synced" | "stale" | "error";

export type SurfaceObjectRecord = {
  id: string;
  surfaceType: "notion";
  objectType: SurfaceObjectType;
  proxyObjectId: string;
  externalObjectId: string | null;
  lastPushedAt: string | null;
  lastPulledAt: string | null;
  lastExternalUpdatedAt: string | null;
  syncStatus: SurfaceSyncStatus;
  syncError: string | null;
  canonicalHash: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Metadata stored on a notion_workspace_database mapping row alongside the
 * data source id (which is what `external_object_id` holds -- pages are
 * created against a data source, not the database object itself).
 */
export type NotionWorkspaceDatabaseMetadata = {
  databaseId: string;
  dataSourceId: string;
  /**
   * Views this adapter has already created on the database, keyed by view
   * name. Notion's view list endpoint returns bare {object, id} references
   * with no name, so "have I made this view already?" is not answerable from
   * the API without retrieving every view -- recording the ids here keeps
   * ensureViews idempotent at zero API cost on the steady-state path.
   */
  views?: Record<string, string>;
};
