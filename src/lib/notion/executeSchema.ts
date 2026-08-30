import type { CreateDatabaseParameters } from "@notionhq/client";

/**
 * Property schema for a database's initial data source, keyed the same way
 * `databases.create({ initial_data_source: { properties } })` expects.
 */
export type DataSourcePropertySchema = NonNullable<
  CreateDatabaseParameters["initial_data_source"]
>["properties"];

/**
 * Execute -> Notion property contracts (Brief Part 3). Kept intentionally
 * close to the underlying execute_project_states / execution_items /
 * execute_work_blocks columns so the mapping in syncExecute.ts stays
 * mechanical -- Notion renders and collects edits, it does not define new
 * shape for this data.
 */

export const EXECUTE_PROJECTS_PROPERTIES: DataSourcePropertySchema = {
  Name: { type: "title", title: {} },
  "Priority Tier": {
    type: "select",
    select: { options: [{ name: "P1" }, { name: "P2" }, { name: "P3" }, { name: "background" }] },
  },
  "Next Plateau": { type: "rich_text", rich_text: {} },
  "Desired Outcome": { type: "rich_text", rich_text: {} },
  Timing: { type: "date", date: {} },
  Protection: {
    type: "select",
    select: { options: [{ name: "protected" }, { name: "normal" }, { name: "flexible" }] },
  },
  "Attention Priority": {
    type: "select",
    select: { options: [{ name: "high" }, { name: "normal" }, { name: "low" }] },
  },
  Status: {
    type: "select",
    select: { options: [{ name: "active" }, { name: "operationally_complete" }, { name: "inactive" }] },
  },
  // CoS prioritization (Phase 6) added priority_directive.why/reassessAt
  // after this database was first created; additive properties so
  // existing pages/views are unaffected.
  "Priority Why": { type: "rich_text", rich_text: {} },
  "Reassess At": { type: "date", date: {} },
};

export function executeItemsProperties(projectsDataSourceId: string): DataSourcePropertySchema {
  return {
    Title: { type: "title", title: {} },
    Project: {
      type: "relation",
      relation: { data_source_id: projectsDataSourceId, single_property: {} },
    },
    Status: {
      type: "select",
      select: {
        options: [
          { name: "candidate" },
          { name: "active" },
          { name: "completed" },
          { name: "cancelled" },
          { name: "deferred" },
        ],
      },
    },
    Responsibility: {
      type: "select",
      select: { options: [{ name: "mine" }, { name: "external" }] },
    },
    "Estimated Effort (min)": { type: "number", number: {} },
    Timing: { type: "date", date: {} },
    "Timing Kind": {
      type: "select",
      select: { options: [{ name: "must" }, { name: "target" }] },
    },
    "Critical Rank": { type: "number", number: {} },
    "Waiting Since": { type: "date", date: {} },
    "Next Action / Context": { type: "rich_text", rich_text: {} },
    "Proxy ID": { type: "rich_text", rich_text: {} },
    // Post-Phase-5 (external/waiting review) and Phase 6 (CoS
    // prioritization) both added real operational meaning that had no
    // Notion representation until now -- additive properties, same
    // reasoning as the projects database above.
    "Waiting On": { type: "rich_text", rich_text: {} },
    "Expected At": { type: "date", date: {} },
    "Priority Tier": {
      type: "select",
      select: { options: [{ name: "P1" }, { name: "P2" }, { name: "P3" }, { name: "background" }] },
    },
    "Priority Why": { type: "rich_text", rich_text: {} },
    Protection: {
      type: "select",
      select: { options: [{ name: "protected" }, { name: "normal" }, { name: "flexible" }] },
    },
    "Attention Priority": {
      type: "select",
      select: { options: [{ name: "high" }, { name: "normal" }, { name: "low" }] },
    },
    "Reassess At": { type: "date", date: {} },
  };
}

export function executeWorkBlocksProperties(
  projectsDataSourceId: string,
  itemsDataSourceId: string
): DataSourcePropertySchema {
  return {
    Title: { type: "title", title: {} },
    Type: {
      type: "select",
      select: { options: [{ name: "work_block" }, { name: "meeting" }, { name: "deadline" }, { name: "milestone" }] },
    },
    Scheduled: { type: "date", date: {} },
    "Related Project": {
      type: "relation",
      relation: { data_source_id: projectsDataSourceId, single_property: {} },
    },
    "Linked Execution Items": {
      type: "relation",
      relation: { data_source_id: itemsDataSourceId, single_property: {} },
    },
    Status: {
      type: "select",
      select: {
        options: [
          { name: "proposed" },
          { name: "committed" },
          { name: "completed" },
          { name: "partial" },
          { name: "missed" },
          { name: "cancelled" },
        ],
      },
    },
    "Completion Note": { type: "rich_text", rich_text: {} },
    "Proxy ID": { type: "rich_text", rich_text: {} },
  };
}
