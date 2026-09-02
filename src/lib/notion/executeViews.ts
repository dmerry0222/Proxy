import "server-only";

import { notionClient } from "./client";
import type { NotionWorkspaceDatabaseKey } from "./types";

/**
 * The views that make the Execute workspace usable by a human.
 *
 * Two of them carry the whole trust argument of this phase:
 *
 *   CURATED EXECUTE      -- what Proxy currently believes deserves attention.
 *   ALL EXECUTION ITEMS  -- everything actionable Proxy knows about, including
 *                           background, unscheduled, project-less, waiting,
 *                           and explicitly suppressed items, each showing the
 *                           reason it was held back.
 *
 * The second view is not a debug affordance. While trust is still being
 * established, being able to see what Proxy is NOT surfacing is the only way
 * to find out whether its curation is any good, so it is a first-class view
 * with no filter at all.
 *
 * Views are created idempotently: the ids of views this adapter has created
 * are recorded on the workspace database's surface_objects metadata, because
 * Notion's list-views endpoint returns bare ids with no names and cannot
 * answer "does a view called X already exist?" without retrieving each one.
 * A view Dave later renames or edits by hand is therefore left alone -- this
 * seeds a workspace, it does not police it.
 */

export type ViewSpec = {
  name: string;
  type: "table" | "board" | "calendar" | "timeline" | "list";
  /** Data source query filter, same shape as a database query filter. */
  filter?: Record<string, unknown>;
  sorts?: Array<{ property: string; direction: "ascending" | "descending" }>;
  /** Property NAME whose id becomes the calendar/timeline date axis. */
  dateProperty?: string;
  endDateProperty?: string;
  /** Property NAME to group a board by. */
  groupBy?: string;
};

export const EXECUTE_VIEWS: Partial<Record<NotionWorkspaceDatabaseKey, ViewSpec[]>> = {
  execute_projects: [
    {
      name: "Active Projects",
      type: "table",
      filter: { property: "Status", select: { equals: "active" } },
      sorts: [{ property: "Target Date", direction: "ascending" }],
    },
    { name: "All Projects", type: "table" },
    { name: "By Priority", type: "board", groupBy: "Priority Tier" },
    { name: "Project Timeline", type: "timeline", dateProperty: "Target Date" },
  ],
  execute_items: [
    {
      name: "Curated Execute",
      type: "table",
      filter: { property: "Curated?", checkbox: { equals: true } },
      sorts: [{ property: "Timing", direction: "ascending" }],
    },
    // No filter, deliberately: this is the "everything Proxy knows" view.
    { name: "All Execution Items", type: "table" },
    {
      name: "Suppressed",
      type: "table",
      filter: { property: "Curated?", checkbox: { equals: false } },
    },
    { name: "By Project", type: "board", groupBy: "Project" },
    { name: "Planning Calendar", type: "calendar", dateProperty: "Planned Date" },
    { name: "Due Dates", type: "calendar", dateProperty: "Timing" },
    {
      name: "Unplanned",
      type: "table",
      filter: {
        and: [
          { property: "Curated?", checkbox: { equals: true } },
          { property: "Planned Date", date: { is_empty: true } },
        ],
      },
    },
  ],
  execute_milestones: [
    { name: "All Milestones", type: "table", sorts: [{ property: "Target Date", direction: "ascending" }] },
    { name: "Milestone Timeline", type: "timeline", dateProperty: "Target Date" },
  ],
  execute_meetings: [
    { name: "Upcoming Meetings", type: "table", sorts: [{ property: "When", direction: "ascending" }] },
    { name: "Meeting Calendar", type: "calendar", dateProperty: "When" },
    {
      name: "Needs a Plateau",
      type: "table",
      filter: { property: "Plateau Required", rich_text: { is_empty: true } },
      sorts: [{ property: "When", direction: "ascending" }],
    },
  ],
};

type PropertyIdLookup = Map<string, string>;

async function loadPropertyIds(dataSourceId: string): Promise<PropertyIdLookup> {
  const dataSource = await notionClient.dataSources.retrieve({ data_source_id: dataSourceId });
  const properties = (dataSource as { properties?: Record<string, { id?: string }> }).properties ?? {};
  const lookup: PropertyIdLookup = new Map();

  for (const [name, property] of Object.entries(properties)) {
    if (property?.id) lookup.set(name, property.id);
  }

  return lookup;
}

function buildConfiguration(spec: ViewSpec, propertyIds: PropertyIdLookup): Record<string, unknown> | null {
  switch (spec.type) {
    case "calendar": {
      const id = spec.dateProperty ? propertyIds.get(spec.dateProperty) : undefined;
      return id ? { type: "calendar", date_property_id: id } : null;
    }
    case "timeline": {
      const id = spec.dateProperty ? propertyIds.get(spec.dateProperty) : undefined;
      const endId = spec.endDateProperty ? propertyIds.get(spec.endDateProperty) : undefined;
      return id ? { type: "timeline", date_property_id: id, ...(endId ? { end_date_property_id: endId } : {}) } : null;
    }
    case "board": {
      const id = spec.groupBy ? propertyIds.get(spec.groupBy) : undefined;
      return id
        ? { type: "board", group_by: { type: "select", property_id: id, sort: { type: "manual" } } }
        : null;
    }
    default:
      return null;
  }
}

export type ViewEnsureResult = {
  created: Record<string, string>;
  skipped: string[];
  failed: Array<{ name: string; message: string }>;
};

/**
 * Creates any view in `specs` that this adapter has not already created on
 * `dataSourceId`. Returns the new name -> view id pairs for the caller to
 * merge into the database mapping's metadata.
 *
 * Best effort by design: a view that Notion rejects (an unsupported config, a
 * property that does not exist yet) is reported and skipped, never fatal --
 * the page projection matters more than the chrome around it.
 */
export async function ensureViews(params: {
  /**
   * BOTH ids are required. views.create rejects a request carrying only a
   * data_source_id with "Exactly one of database_id, view_id, or
   * create_database must be provided" -- the data source says which rows the
   * view reads, the database says which page the view is added to.
   */
  databaseId: string;
  dataSourceId: string;
  specs: ViewSpec[];
  existing: Record<string, string>;
}): Promise<ViewEnsureResult> {
  const result: ViewEnsureResult = { created: {}, skipped: [], failed: [] };
  const missing = params.specs.filter((spec) => !params.existing[spec.name]);

  if (!missing.length) {
    result.skipped = params.specs.map((spec) => spec.name);
    return result;
  }

  const needsPropertyIds = missing.some((spec) => spec.type !== "table" && spec.type !== "list");
  const propertyIds = needsPropertyIds ? await loadPropertyIds(params.dataSourceId) : new Map<string, string>();

  for (const spec of missing) {
    try {
      const configuration = buildConfiguration(spec, propertyIds);

      if (spec.type !== "table" && spec.type !== "list" && !configuration) {
        result.failed.push({
          name: spec.name,
          message: `Could not resolve the property this ${spec.type} view needs (${spec.dateProperty ?? spec.groupBy ?? "unknown"}).`,
        });
        continue;
      }

      const view = await notionClient.views.create({
        database_id: params.databaseId,
        data_source_id: params.dataSourceId,
        name: spec.name,
        type: spec.type,
        ...(spec.filter ? { filter: spec.filter as never } : {}),
        ...(spec.sorts ? { sorts: spec.sorts as never } : {}),
        ...(configuration ? { configuration: configuration as never } : {}),
      });

      result.created[spec.name] = view.id;
    } catch (error) {
      result.failed.push({ name: spec.name, message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  return result;
}
