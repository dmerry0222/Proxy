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
  // Projects became first-class objects (not status overlays on a Memory
  // entity), so the page now carries the project itself: what it is, why it
  // matters, and when it is meant to land.
  Description: { type: "rich_text", rich_text: {} },
  "Why It Matters": { type: "rich_text", rich_text: {} },
  "Target Date": { type: "date", date: {} },
  "Proxy ID": { type: "rich_text", rich_text: {} },
};

export function executeItemsProperties(projectsDataSourceId: string): DataSourcePropertySchema {
  return {
    Title: { type: "title", title: {} },
    /*
     * dual_property, not single_property: it puts an "Execution Items"
     * backlink on every Project page, which is what makes a Project page a
     * container you can actually work from rather than a card with a name on
     * it. Notion maintains the reverse side itself.
     */
    Project: {
      type: "relation",
      relation: {
        data_source_id: projectsDataSourceId,
        dual_property: { synced_property_name: "Execution Items" },
      },
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
    /*
     * Curation, made legible. "Curated?" is what separates the day-to-day
     * view from the audit view, and the two reason fields mean Dave never has
     * to guess why an item is (or is not) in front of him. All four are
     * Proxy-owned: they are recomputed from curationPolicy.ts, so a human
     * edit here would be overwritten on the next sweep and is not treated as
     * input.
     */
    "Curated?": { type: "checkbox", checkbox: {} },
    "Why Surfaced": { type: "rich_text", rich_text: {} },
    "Why Suppressed": { type: "rich_text", rich_text: {} },
    "Last Assessed": { type: "date", date: {} },
    /*
     * Dave's manual planning date -- the one Execute field Notion OWNS. It is
     * dragged around by hand in the calendar/timeline views and pulled back
     * into Supabase by pullExecute.ts. Deliberately separate from "Timing",
     * which is the due/target date the world imposes: conflating them would
     * destroy exactly the signal this phase exists to collect.
     */
    "Planned Date": { type: "date", date: {} },
    Source: {
      type: "select",
      select: {
        options: [
          { name: "mailroom" },
          { name: "artifact" },
          { name: "meeting" },
          { name: "manual" },
          { name: "reconciliation" },
          { name: "notion" },
        ],
      },
    },
    "Source Ref": { type: "rich_text", rich_text: {} },
  };
}

/**
 * MILESTONES: durable named accomplishments inside a Project. Distinct from
 * the PLATEAU on a meeting page (see the meetings schema below), which is a
 * required state rather than an accomplishment.
 */
export function executeMilestonesProperties(projectsDataSourceId: string): DataSourcePropertySchema {
  return {
    Name: { type: "title", title: {} },
    Project: {
      type: "relation",
      relation: {
        data_source_id: projectsDataSourceId,
        dual_property: { synced_property_name: "Milestones" },
      },
    },
    Status: {
      type: "select",
      select: {
        options: [
          { name: "planned" },
          { name: "in_progress" },
          { name: "achieved" },
          { name: "abandoned" },
        ],
      },
    },
    "Target Date": { type: "date", date: {} },
    Description: { type: "rich_text", rich_text: {} },
    "Achieved At": { type: "date", date: {} },
    "Proxy ID": { type: "rich_text", rich_text: {} },
  };
}

/**
 * MEETINGS: one page per canonical Outlook calendar event.
 *
 * Two ownership zones, and the split is the entire point of this database:
 *
 *  - OUTLOOK-OWNED (Meeting, When, Organizer, Attendees, Recurring, Outlook
 *    Event ID, Link): projected from calendar_events on every sync and never
 *    read back. Editing them in Notion changes nothing anywhere -- Outlook
 *    remains the only writer of what a meeting IS.
 *  - PROXY/HUMAN-OWNED (Related Project, Related Milestone, Plateau Required,
 *    Preparation Notes): stored in execute_touchpoints, pulled back from
 *    Notion, and never written onto the Outlook event.
 *
 * That is why enrichment is a related row rather than extra columns on
 * calendar_events: there is no code path in which Notion can reach a
 * source-owned calendar field.
 */
export function executeMeetingsProperties(
  projectsDataSourceId: string,
  milestonesDataSourceId: string
): DataSourcePropertySchema {
  return {
    Meeting: { type: "title", title: {} },
    When: { type: "date", date: {} },
    Organizer: { type: "rich_text", rich_text: {} },
    Attendees: { type: "rich_text", rich_text: {} },
    Recurring: { type: "checkbox", checkbox: {} },
    "Related Project": {
      type: "relation",
      relation: {
        data_source_id: projectsDataSourceId,
        dual_property: { synced_property_name: "Meetings" },
      },
    },
    "Related Milestone": {
      type: "relation",
      relation: { data_source_id: milestonesDataSourceId, single_property: {} },
    },
    "Plateau Required": { type: "rich_text", rich_text: {} },
    "Preparation Notes": { type: "rich_text", rich_text: {} },
    "Outlook Event ID": { type: "rich_text", rich_text: {} },
    Link: { type: "url", url: {} },
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
