import "server-only";

import { emitDiagnosticEvent, recordOrUpdateIssue, resolveIssueByDedupKey } from "@/lib/diagnostics/emitEvent";
import {
  createMilestone,
  createProject,
  setMeetingPlateau,
  updateMilestone,
  updateProject,
} from "@/lib/execute/projects";
import { supabaseServer } from "@/lib/supabase/server";
import { notionClient } from "./client";
import { releaseGuardedBaseline, type ComparableValue } from "./guardedProperties";
import {
  getSurfaceMapping,
  getSurfaceMappingByExternalId,
  ensureSurfaceMapping,
  markPulled,
  markPushed,
  updateMappingMetadata,
} from "./mapping";
import { comparableValue } from "./pageSync";
import type { NotionWorkspaceDatabaseKey, SurfaceObjectRecord, SurfaceObjectType } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Notion -> Supabase, for the small set of Execute fields Notion legitimately
 * owns.
 *
 * This is what makes the Notion workspace a place Dave can actually work
 * rather than a read-only report: dragging an item onto a day, filing it
 * under a project, writing the plateau a Thursday review has to hit. Supabase
 * stays canonical -- Notion is where the human input happens, and this is the
 * path by which that input becomes durable state.
 *
 * WHAT IS DELIBERATELY NOT PULLED
 *
 *  - Anything Outlook owns. Meeting title, times, organizer, attendees,
 *    recurrence and Outlook identity are projected onto the meeting page and
 *    never read back; the only thing a meeting page can change is its
 *    execute_touchpoints enrichment row. There is no code path from a Notion
 *    edit to a calendar_events column.
 *  - Curation. "Curated?", "Why Surfaced", "Why Suppressed" and "Last
 *    Assessed" are Proxy's own reasoning, recomputed every sweep. Editing
 *    them in Notion changes nothing, by design -- curation is meant to be
 *    inspected and argued with, not hand-patched.
 *  - Priority. Tier/protection/attention are the Chief of Staff's, and it
 *    does not exist yet. Nothing here writes priority_directive.
 *  - Status transitions on execution items, which route through the existing
 *    review actions so their audit trail stays intact.
 *
 * HOW "DID A HUMAN CHANGE THIS?" IS DECIDED
 *
 * Not by last_edited_time, which moves for any reason. Each guarded property
 * carries a baseline of what Proxy last wrote (guardedProperties.ts); a live
 * value that differs from that baseline is a human edit. After adopting it,
 * the baseline is RELEASED so the property returns to normal two-way sync
 * instead of being frozen as a permanent override.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 25;

export type PullCounts = { scanned: number; changed: number; adopted: number; skipped: number };

export type PullExecuteSummary = {
  dryRun: boolean;
  projects: PullCounts;
  items: PullCounts;
  milestones: PullCounts;
  meetings: PullCounts;
  errors: Array<{ objectType: string; objectId: string; message: string }>;
};

function emptyPullCounts(): PullCounts {
  return { scanned: 0, changed: 0, adopted: 0, skipped: 0 };
}

function plainText(properties: any, key: string): string | null {
  const property = properties?.[key];
  if (!property) return null;
  const chunks = property.type === "title" ? property.title : property.type === "rich_text" ? property.rich_text : null;
  if (!chunks) return null;
  const text = (chunks as any[]).map((chunk) => chunk?.plain_text ?? "").join("");
  return text.length > 0 ? text : null;
}

function dateStart(properties: any, key: string): string | null {
  const property = properties?.[key];
  return property?.type === "date" ? property.date?.start ?? null : null;
}

function selectName(properties: any, key: string): string | null {
  const property = properties?.[key];
  return property?.type === "select" ? property.select?.name ?? null : null;
}

function relationPageId(properties: any, key: string): string | null {
  const property = properties?.[key];
  return property?.type === "relation" ? property.relation?.[0]?.id ?? null : null;
}

function checkboxValue(properties: any, key: string): boolean {
  const property = properties?.[key];
  return property?.type === "checkbox" ? property.checkbox === true : false;
}

function baselineOf(mapping: SurfaceObjectRecord): Record<string, ComparableValue> {
  const stored = mapping.metadata?.guardedBaseline;
  return stored && typeof stored === "object" ? (stored as Record<string, ComparableValue>) : {};
}

/**
 * A guarded property counts as a human edit only when Proxy has a record of
 * what it last wrote AND the live value differs. With no baseline there is no
 * evidence of an edit, and adopting the live value would just re-import
 * Proxy's own output.
 */
function changedProperties(page: any, mapping: SurfaceObjectRecord, guarded: string[]): string[] {
  const baseline = baselineOf(mapping);
  const changed: string[] = [];

  for (const name of guarded) {
    if (!Object.prototype.hasOwnProperty.call(baseline, name)) continue;
    const live = comparableValue(page.properties?.[name]);
    if (live !== baseline[name]) changed.push(name);
  }

  return changed;
}

async function releaseBaselines(mapping: SurfaceObjectRecord, names: string[]): Promise<void> {
  if (!names.length) return;
  await updateMappingMetadata(mapping.id, {
    ...mapping.metadata,
    guardedBaseline: releaseGuardedBaseline(baselineOf(mapping), names),
  });
}

async function queryPages(dataSourceId: string, since: string | null): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response: any = await notionClient.dataSources.query({
      data_source_id: dataSourceId,
      page_size: PAGE_SIZE,
      ...(cursor ? { start_cursor: cursor } : {}),
      ...(since
        ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } } as any }
        : {}),
    });

    pages.push(...(response.results ?? []));
    if (!response.has_more || !response.next_cursor) break;
    cursor = response.next_cursor;
  }

  return pages;
}

/**
 * Resolves a data source to pull from, plus the incremental cursor for it.
 * The cursor is the workspace database mapping's last_pulled_at, minus a
 * small overlap so an edit made during the previous pull is not missed.
 */
const CURSOR_OVERLAP_MS = 5 * 60_000;

async function resolveSource(
  key: NotionWorkspaceDatabaseKey
): Promise<{ mapping: SurfaceObjectRecord; dataSourceId: string; since: string | null } | null> {
  const mapping = await getSurfaceMapping("notion_workspace_database", key);
  if (!mapping?.externalObjectId) return null;

  const since = mapping.lastPulledAt
    ? new Date(new Date(mapping.lastPulledAt).getTime() - CURSOR_OVERLAP_MS).toISOString()
    : null;

  return { mapping, dataSourceId: mapping.externalObjectId, since };
}

async function projectStateIdForPage(pageId: string | null): Promise<string | null> {
  if (!pageId) return null;
  const mapping = await getSurfaceMappingByExternalId("execute_project", pageId);
  return mapping?.proxyObjectId ?? null;
}

async function milestoneIdForPage(pageId: string | null): Promise<string | null> {
  if (!pageId) return null;
  const mapping = await getSurfaceMappingByExternalId("execute_milestone", pageId);
  return mapping?.proxyObjectId ?? null;
}

/**
 * Records a Notion-authored page as a Proxy object, so the next push updates
 * that same page instead of creating a duplicate alongside it.
 */
async function adoptPage(objectType: SurfaceObjectType, proxyObjectId: string, pageId: string): Promise<void> {
  const mapping = await ensureSurfaceMapping(objectType, proxyObjectId);
  await markPushed(mapping.id, { externalObjectId: pageId, canonicalHash: "adopted-from-notion" });
}

const PROJECT_GUARDED = [
  "Name",
  "Description",
  "Desired Outcome",
  "Why It Matters",
  "Target Date",
  "Next Plateau",
  "Status",
];

async function pullProjects(dryRun: boolean, summary: PullExecuteSummary): Promise<void> {
  const source = await resolveSource("execute_projects");
  if (!source) return;

  const pages = await queryPages(source.dataSourceId, source.since);

  for (const page of pages) {
    summary.projects.scanned += 1;
    const mapping = await getSurfaceMappingByExternalId("execute_project", page.id);
    const title = plainText(page.properties, "Name");

    if (!mapping) {
      /*
       * A project page Dave created by hand. Adopting it (rather than
       * ignoring it, or letting the next push create a second page for the
       * same project) is what makes Notion a usable place to start a
       * project. An untitled page is skipped -- it is a blank row, not a
       * project.
       */
      if (!title) {
        summary.projects.skipped += 1;
        continue;
      }
      if (dryRun) {
        summary.projects.adopted += 1;
        continue;
      }

      try {
        const project = await createProject({
          title,
          description: plainText(page.properties, "Description"),
          desiredOutcome: plainText(page.properties, "Desired Outcome"),
          whyItMatters: plainText(page.properties, "Why It Matters"),
          targetDate: dateStart(page.properties, "Target Date"),
          nextPlateau: plainText(page.properties, "Next Plateau"),
          status: (selectName(page.properties, "Status") as never) ?? "active",
          createdBy: "notion",
        });
        await adoptPage("execute_project", project.id, page.id);
        summary.projects.adopted += 1;
      } catch (error) {
        summary.errors.push({
          objectType: "execute_project",
          objectId: page.id,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      continue;
    }

    const changed = changedProperties(page, mapping, PROJECT_GUARDED);
    if (!changed.length) {
      summary.projects.skipped += 1;
      continue;
    }
    if (dryRun) {
      summary.projects.changed += 1;
      continue;
    }

    try {
      const patch: Record<string, unknown> = {};
      if (changed.includes("Name") && title) patch.title = title;
      if (changed.includes("Description")) patch.description = plainText(page.properties, "Description");
      if (changed.includes("Desired Outcome")) patch.desiredOutcome = plainText(page.properties, "Desired Outcome");
      if (changed.includes("Why It Matters")) patch.whyItMatters = plainText(page.properties, "Why It Matters");
      if (changed.includes("Target Date")) patch.targetDate = dateStart(page.properties, "Target Date");
      if (changed.includes("Next Plateau")) patch.nextPlateau = plainText(page.properties, "Next Plateau");
      if (changed.includes("Status")) {
        const status = selectName(page.properties, "Status");
        if (status) patch.status = status;
      }

      await updateProject(mapping.proxyObjectId, patch as never);
      await releaseBaselines(mapping, changed);
      summary.projects.changed += 1;
    } catch (error) {
      summary.errors.push({
        objectType: "execute_project",
        objectId: mapping.proxyObjectId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (!dryRun) await markPulled(source.mapping.id, {});
}

const ITEM_GUARDED = ["Planned Date", "Project"];

async function pullItems(dryRun: boolean, summary: PullExecuteSummary): Promise<void> {
  const source = await resolveSource("execute_items");
  if (!source) return;

  const pages = await queryPages(source.dataSourceId, source.since);

  for (const page of pages) {
    summary.items.scanned += 1;
    const mapping = await getSurfaceMappingByExternalId("execute_item", page.id);

    /*
     * Items are NOT adopted from Notion. Execution items are supposed to
     * arrive from real sources -- mail, meetings, artifacts, the Execute UI --
     * each carrying provenance; a bare Notion row would be a task with no
     * evidence behind it, which is exactly the "competing task list" this
     * architecture is trying to avoid.
     */
    if (!mapping) {
      summary.items.skipped += 1;
      continue;
    }

    const changed = changedProperties(page, mapping, ITEM_GUARDED);
    if (!changed.length) {
      summary.items.skipped += 1;
      continue;
    }
    if (dryRun) {
      summary.items.changed += 1;
      continue;
    }

    try {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (changed.includes("Planned Date")) patch.planned_at = dateStart(page.properties, "Planned Date");
      if (changed.includes("Project")) {
        patch.project_state_id = await projectStateIdForPage(relationPageId(page.properties, "Project"));
      }

      const { error } = await supabaseServer.from("execution_items").update(patch).eq("id", mapping.proxyObjectId);
      if (error) throw new Error(error.message);

      await releaseBaselines(mapping, changed);
      summary.items.changed += 1;
    } catch (error) {
      summary.errors.push({
        objectType: "execute_item",
        objectId: mapping.proxyObjectId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (!dryRun) await markPulled(source.mapping.id, {});
}

const MILESTONE_GUARDED = ["Name", "Status", "Target Date", "Description"];

async function pullMilestones(dryRun: boolean, summary: PullExecuteSummary): Promise<void> {
  const source = await resolveSource("execute_milestones");
  if (!source) return;

  const pages = await queryPages(source.dataSourceId, source.since);

  for (const page of pages) {
    summary.milestones.scanned += 1;
    const mapping = await getSurfaceMappingByExternalId("execute_milestone", page.id);
    const title = plainText(page.properties, "Name");

    if (!mapping) {
      const projectStateId = await projectStateIdForPage(relationPageId(page.properties, "Project"));
      // A milestone with no project is not a milestone of anything.
      if (!title || !projectStateId) {
        summary.milestones.skipped += 1;
        continue;
      }
      if (dryRun) {
        summary.milestones.adopted += 1;
        continue;
      }

      try {
        const milestone = await createMilestone({
          projectStateId,
          title,
          description: plainText(page.properties, "Description"),
          targetDate: dateStart(page.properties, "Target Date"),
          status: selectName(page.properties, "Status") ?? "planned",
          createdBy: "notion",
        });
        await adoptPage("execute_milestone", milestone.id, page.id);
        summary.milestones.adopted += 1;
      } catch (error) {
        summary.errors.push({
          objectType: "execute_milestone",
          objectId: page.id,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      continue;
    }

    const changed = changedProperties(page, mapping, MILESTONE_GUARDED);
    if (!changed.length) {
      summary.milestones.skipped += 1;
      continue;
    }
    if (dryRun) {
      summary.milestones.changed += 1;
      continue;
    }

    try {
      await updateMilestone(mapping.proxyObjectId, {
        ...(changed.includes("Name") && title ? { title } : {}),
        ...(changed.includes("Description") ? { description: plainText(page.properties, "Description") } : {}),
        ...(changed.includes("Target Date") ? { targetDate: dateStart(page.properties, "Target Date") } : {}),
        ...(changed.includes("Status") && selectName(page.properties, "Status")
          ? { status: selectName(page.properties, "Status") as string }
          : {}),
      });
      await releaseBaselines(mapping, changed);
      summary.milestones.changed += 1;
    } catch (error) {
      summary.errors.push({
        objectType: "execute_milestone",
        objectId: mapping.proxyObjectId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (!dryRun) await markPulled(source.mapping.id, {});
}

const MEETING_GUARDED = ["Related Project", "Related Milestone", "Plateau Required", "Preparation Notes"];

async function pullMeetings(dryRun: boolean, summary: PullExecuteSummary): Promise<void> {
  const source = await resolveSource("execute_meetings");
  if (!source) return;

  const pages = await queryPages(source.dataSourceId, source.since);

  for (const page of pages) {
    summary.meetings.scanned += 1;
    const mapping = await getSurfaceMappingByExternalId("calendar_event", page.id);

    /*
     * No adoption here, and that is the point: a meeting page exists because
     * an Outlook event exists. A hand-made row has no canonical event behind
     * it, and inventing one would be Notion writing calendar truth.
     */
    if (!mapping) {
      summary.meetings.skipped += 1;
      continue;
    }

    const changed = changedProperties(page, mapping, MEETING_GUARDED);
    if (!changed.length) {
      summary.meetings.skipped += 1;
      continue;
    }
    if (dryRun) {
      summary.meetings.changed += 1;
      continue;
    }

    try {
      const relatedProjectPageId = relationPageId(page.properties, "Related Project");
      const relatedMilestonePageId = relationPageId(page.properties, "Related Milestone");
      const [projectStateId, milestoneId] = await Promise.all([
        projectStateIdForPage(relatedProjectPageId),
        milestoneIdForPage(relatedMilestonePageId),
      ]);

      // A relation was set in Notion but doesn't resolve to a known Proxy
      // object -- surfaced in Inspector General rather than silently dropped
      // (the guarded write still proceeds with that one relation left
      // unset, same as an absent relation).
      const invalidDedupKey = `notion_calendar_invalid_relation:${page.id}`;
      if ((relatedProjectPageId && !projectStateId) || (relatedMilestonePageId && !milestoneId)) {
        await recordOrUpdateIssue(invalidDedupKey, {
          issueType: "notion_calendar_invalid_relation",
          severity: "warning",
          humanSummary: `Meeting page's Related Project/Milestone points at a Notion page with no known Proxy object.`,
          technicalDetail: `relatedProjectPageId=${relatedProjectPageId ?? "none"} resolved=${projectStateId ?? "none"}; relatedMilestonePageId=${relatedMilestonePageId ?? "none"} resolved=${milestoneId ?? "none"}`,
          objectType: "calendar_event",
          objectId: mapping.proxyObjectId,
          sourceType: "notion",
          sourceId: page.id,
          retryable: false,
        });
      } else {
        await resolveIssueByDedupKey(invalidDedupKey, "Relation now resolves to a known Proxy object.");
      }

      /*
       * The enrichment row is written whole, from the page's current state:
       * project, milestone, plateau and prep notes describe one meeting
       * together, and patching them field-by-field across two identity keys
       * (project-scoped vs project-less) would be a much easier way to
       * create orphans.
       */
      await setMeetingPlateau({
        calendarEventId: mapping.proxyObjectId,
        projectStateId,
        milestoneId,
        desiredState: plainText(page.properties, "Plateau Required"),
        preparationNotes: plainText(page.properties, "Preparation Notes"),
        reviewed: checkboxValue(page.properties, "Reviewed"),
        createdBy: "notion",
        notionPageId: page.id,
      });

      await releaseBaselines(mapping, changed);
      summary.meetings.changed += 1;
    } catch (error) {
      summary.errors.push({
        objectType: "calendar_event",
        objectId: mapping.proxyObjectId,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  if (!dryRun) await markPulled(source.mapping.id, {});
}

export async function pullExecuteFromNotion(options: {
  dryRun: boolean;
  traceId: string | null;
}): Promise<PullExecuteSummary> {
  const summary: PullExecuteSummary = {
    dryRun: options.dryRun,
    projects: emptyPullCounts(),
    items: emptyPullCounts(),
    milestones: emptyPullCounts(),
    meetings: emptyPullCounts(),
    errors: [],
  };

  // Projects first: milestones and meetings both resolve relations to
  // project rows, including ones adopted moments earlier in this same pull.
  await pullProjects(options.dryRun, summary);
  await pullMilestones(options.dryRun, summary);
  await pullItems(options.dryRun, summary);
  await pullMeetings(options.dryRun, summary);

  await emitDiagnosticEvent({
    traceId: options.traceId,
    module: "notion",
    stage: "pull_execute",
    eventType: "pull_completed",
    status: summary.errors.length ? "failure" : "success",
    humanSummary: `Notion → Execute pull: ${summary.projects.changed + summary.items.changed + summary.milestones.changed + summary.meetings.changed} change(s), ${summary.projects.adopted + summary.milestones.adopted} adopted, ${summary.errors.length} error(s)`,
    metadata: {
      projects: summary.projects,
      items: summary.items,
      milestones: summary.milestones,
      meetings: summary.meetings,
    },
  });

  return summary;
}
