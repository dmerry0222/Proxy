import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

/**
 * Projects, Milestones, and Plateaus -- the container layer of Execute.
 *
 * The hierarchy is deliberately shallow, and deliberately two-branched:
 *
 *   PROJECT -> EXECUTION ITEMS        (what work exists)
 *   PROJECT -> MILESTONES / PLATEAUS  (what progress means)
 *
 * There is no Solutions/Epics/Features/Tasks ladder, and nothing here
 * introduces one.
 *
 * MILESTONE  = a durable named accomplishment (execute_milestones).
 * PLATEAU    = the state the project must have reached by a given touchpoint,
 *              usually a meeting (execute_touchpoints.desired_state). A
 *              plateau may point at a milestone, but usually will not.
 *
 * A Project is stored in execute_project_states. That table used to be a thin
 * status overlay on a Memory project entity; it is now the Project itself,
 * with the Memory link kept as optional provenance.
 */

export type ExecuteProjectStatus = "active" | "operationally_complete" | "inactive";

export type ProjectRecord = {
  id: string;
  title: string;
  description: string | null;
  desiredOutcome: string | null;
  whyItMatters: string | null;
  status: string;
  targetDate: string | null;
  nextPlateau: string | null;
  memoryProjectEntityId: string | null;
  ownerEntityId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type MilestoneRecord = {
  id: string;
  projectStateId: string;
  title: string;
  description: string | null;
  targetDate: string | null;
  status: string;
  achievedAt: string | null;
  position: number;
};

export type TouchpointRecord = {
  id: string;
  projectStateId: string | null;
  milestoneId: string | null;
  calendarEventId: string;
  /** The PLATEAU required by this touchpoint. */
  desiredState: string | null;
  preparationNotes: string | null;
  createdBy: string;
};

type ProjectRow = {
  id: string;
  title: string | null;
  description: string | null;
  desired_outcome: string | null;
  why_it_matters: string | null;
  status: string;
  target_date: string | null;
  next_plateau: string | null;
  memory_project_entity_id: string | null;
  owner_entity_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  memory_entities?: { canonical_name: string } | { canonical_name: string }[] | null;
};

/*
 * The embed names its foreign key explicitly. execute_project_states now has
 * TWO references to memory_entities (the project link and owner_entity_id),
 * and PostgREST refuses an ambiguous embed with "more than one relationship
 * was found" rather than guessing.
 */
const PROJECT_COLUMNS =
  "id, title, description, desired_outcome, why_it_matters, status, target_date, next_plateau, memory_project_entity_id, owner_entity_id, created_by, created_at, updated_at, memory_entities!execute_project_states_memory_project_entity_id_fkey(canonical_name)";

/**
 * Title resolution in exactly one place: Execute's own title wins, and a
 * linked Memory entity's canonical name is the fallback. Two writers, one
 * rule -- so a project created in Notion and a project promoted from Memory
 * both display correctly without either side clobbering the other.
 */
export function resolveProjectTitle(row: {
  title: string | null;
  memory_entities?: { canonical_name: string } | { canonical_name: string }[] | null;
}): string {
  if (row.title?.trim()) return row.title.trim();
  const memory = Array.isArray(row.memory_entities) ? row.memory_entities[0] : row.memory_entities;
  return memory?.canonical_name?.trim() || "Untitled project";
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    title: resolveProjectTitle(row),
    description: row.description,
    desiredOutcome: row.desired_outcome,
    whyItMatters: row.why_it_matters,
    status: row.status,
    targetDate: row.target_date,
    nextPlateau: row.next_plateau,
    memoryProjectEntityId: row.memory_project_entity_id,
    ownerEntityId: row.owner_entity_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProjects(options?: { activeOnly?: boolean }): Promise<ProjectRecord[]> {
  let query = supabaseServer.from("execute_project_states").select(PROJECT_COLUMNS);
  if (options?.activeOnly) query = query.eq("status", "active");

  const { data, error } = await query.order("updated_at", { ascending: false });
  if (error) throw new Error(`Could not load Execute projects: ${error.message}`);

  return ((data ?? []) as unknown as ProjectRow[]).map(toProjectRecord);
}

export async function getProject(projectStateId: string): Promise<ProjectRecord | null> {
  const { data, error } = await supabaseServer
    .from("execute_project_states")
    .select(PROJECT_COLUMNS)
    .eq("id", projectStateId)
    .maybeSingle();

  if (error) throw new Error(`Could not load Execute project: ${error.message}`);
  return data ? toProjectRecord(data as unknown as ProjectRow) : null;
}

export type CreateProjectInput = {
  title: string;
  description?: string | null;
  desiredOutcome?: string | null;
  whyItMatters?: string | null;
  status?: ExecuteProjectStatus;
  targetDate?: string | null;
  nextPlateau?: string | null;
  memoryProjectEntityId?: string | null;
  createdBy?: "proxy" | "proxy_ui" | "notion";
};

/**
 * Creates a Project. When a Memory project entity is supplied, the existing
 * unique constraint on memory_project_entity_id makes this an upsert -- the
 * same "activate this Memory project" behaviour mutateExecute.ts already
 * had, now able to carry real project content with it.
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const payload = {
    title: input.title.trim().slice(0, 300),
    description: input.description?.trim() || null,
    desired_outcome: input.desiredOutcome?.trim() || null,
    why_it_matters: input.whyItMatters?.trim() || null,
    status: input.status ?? "active",
    target_date: input.targetDate || null,
    next_plateau: input.nextPlateau?.trim() || null,
    memory_project_entity_id: input.memoryProjectEntityId ?? null,
    created_by: input.createdBy ?? "proxy",
    updated_at: new Date().toISOString(),
  };

  const query = payload.memory_project_entity_id
    ? supabaseServer.from("execute_project_states").upsert(payload, { onConflict: "memory_project_entity_id" })
    : supabaseServer.from("execute_project_states").insert(payload);

  const { data, error } = await query.select(PROJECT_COLUMNS).single();
  if (error || !data) throw new Error(`Could not create Execute project: ${error?.message ?? "Unknown error"}`);

  return toProjectRecord(data as unknown as ProjectRow);
}

export async function updateProject(
  projectStateId: string,
  patch: Partial<Omit<CreateProjectInput, "memoryProjectEntityId" | "createdBy">>
): Promise<void> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) payload.title = patch.title?.trim().slice(0, 300) || null;
  if (patch.description !== undefined) payload.description = patch.description?.trim() || null;
  if (patch.desiredOutcome !== undefined) payload.desired_outcome = patch.desiredOutcome?.trim() || null;
  if (patch.whyItMatters !== undefined) payload.why_it_matters = patch.whyItMatters?.trim() || null;
  if (patch.status !== undefined) payload.status = patch.status;
  if (patch.targetDate !== undefined) payload.target_date = patch.targetDate || null;
  if (patch.nextPlateau !== undefined) payload.next_plateau = patch.nextPlateau?.trim() || null;

  const { error } = await supabaseServer.from("execute_project_states").update(payload).eq("id", projectStateId);
  if (error) throw new Error(`Could not update Execute project: ${error.message}`);
}

export async function listMilestones(projectStateId?: string): Promise<MilestoneRecord[]> {
  let query = supabaseServer
    .from("execute_milestones")
    .select("id, project_state_id, title, description, target_date, status, achieved_at, position");
  if (projectStateId) query = query.eq("project_state_id", projectStateId);

  const { data, error } = await query.order("target_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Could not load milestones: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    projectStateId: row.project_state_id,
    title: row.title,
    description: row.description,
    targetDate: row.target_date,
    status: row.status,
    achievedAt: row.achieved_at,
    position: row.position,
  }));
}

export type CreateMilestoneInput = {
  projectStateId: string;
  title: string;
  description?: string | null;
  targetDate?: string | null;
  status?: string;
  createdBy?: "proxy" | "proxy_ui" | "notion";
};

export async function createMilestone(input: CreateMilestoneInput): Promise<{ id: string }> {
  const { data, error } = await supabaseServer
    .from("execute_milestones")
    .insert({
      project_state_id: input.projectStateId,
      title: input.title.trim().slice(0, 300),
      description: input.description?.trim() || null,
      target_date: input.targetDate || null,
      status: input.status ?? "planned",
      created_by: input.createdBy ?? "proxy",
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Could not create milestone: ${error?.message ?? "Unknown error"}`);
  return { id: data.id as string };
}

export async function updateMilestone(
  milestoneId: string,
  patch: { title?: string; description?: string | null; targetDate?: string | null; status?: string }
): Promise<void> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) payload.title = patch.title.trim().slice(0, 300);
  if (patch.description !== undefined) payload.description = patch.description?.trim() || null;
  if (patch.targetDate !== undefined) payload.target_date = patch.targetDate || null;
  if (patch.status !== undefined) {
    payload.status = patch.status;
    if (patch.status === "achieved") payload.achieved_at = new Date().toISOString();
  }

  const { error } = await supabaseServer.from("execute_milestones").update(payload).eq("id", milestoneId);
  if (error) throw new Error(`Could not update milestone: ${error.message}`);
}

export type PlateauInput = {
  calendarEventId: string;
  projectStateId: string | null;
  milestoneId?: string | null;
  /** The plateau: what state the project must be in by this meeting. */
  desiredState?: string | null;
  preparationNotes?: string | null;
  reviewed?: boolean;
  createdBy?: "ai" | "notion" | "proxy_ui";
  confidence?: number | null;
  /** The Notion page this write originated from, for the audit trail. Null for a non-Notion write. */
  notionPageId?: string | null;
};

/**
 * Attaches (or updates) Proxy-owned meaning on a canonical Outlook event.
 *
 * The calendar_events row is never written to. Everything Proxy or Dave has
 * to say about a meeting -- which project it serves, which milestone, the
 * plateau required by it, how to prepare -- lives here, keyed by the Outlook
 * event id. That separation is the whole reason this is a related table
 * rather than extra columns on the event.
 *
 * Upsert identity is (project_state_id, calendar_event_id), already unique;
 * project-less enrichment is kept single per event by a partial unique index,
 * so "notes on this meeting, no project yet" cannot silently multiply.
 */
const AUDITED_FIELDS = ["project_state_id", "milestone_id", "desired_state", "preparation_notes", "reviewed"] as const;

async function recordTouchpointAudit(input: {
  touchpointId: string;
  calendarEventId: string;
  notionPageId: string | null;
  source: "notion" | "proxy_ui" | "ai" | "system";
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}): Promise<void> {
  const rows = AUDITED_FIELDS.filter((field) => (input.previous[field] ?? null) !== (input.next[field] ?? null)).map(
    (field) => ({
      touchpoint_id: input.touchpointId,
      calendar_event_id: input.calendarEventId,
      notion_page_id: input.notionPageId,
      field,
      previous_value: input.previous[field] === null || input.previous[field] === undefined ? null : String(input.previous[field]),
      new_value: input.next[field] === null || input.next[field] === undefined ? null : String(input.next[field]),
      source: input.source,
      human_confirmed: input.source === "notion" || input.source === "proxy_ui",
    })
  );
  if (!rows.length) return;
  const { error } = await supabaseServer.from("execute_touchpoint_audit").insert(rows);
  if (error) console.error("Could not record execute_touchpoint_audit rows:", error.message);
}

/**
 * Writes one meeting's enrichment row whole (see PlateauInput doc) and, for
 * every guarded field that actually changed, one execute_touchpoint_audit
 * row -- add/change/clear are all just a previous/new value pair, clearing
 * being new_value: null. Priority 6: this audit trail was the real gap in an
 * otherwise-already-safe mechanism (guarded-baseline diffing, no Outlook
 * write-back) that had been live since 2026-09-02 with no history at all.
 */
export async function setMeetingPlateau(input: PlateauInput): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: existingError } = await (input.projectStateId
    ? supabaseServer
        .from("execute_touchpoints")
        .select("id, project_state_id, milestone_id, desired_state, preparation_notes, reviewed")
        .eq("calendar_event_id", input.calendarEventId)
        .eq("project_state_id", input.projectStateId)
        .maybeSingle()
    : supabaseServer
        .from("execute_touchpoints")
        .select("id, project_state_id, milestone_id, desired_state, preparation_notes, reviewed")
        .eq("calendar_event_id", input.calendarEventId)
        .is("project_state_id", null)
        .maybeSingle());

  if (existingError) throw new Error(`Could not look up meeting enrichment: ${existingError.message}`);

  const source: "notion" | "proxy_ui" | "ai" | "system" =
    input.createdBy === "notion" ? "notion" : input.createdBy === "ai" ? "ai" : "proxy_ui";

  const payload = {
    calendar_event_id: input.calendarEventId,
    project_state_id: input.projectStateId,
    milestone_id: input.milestoneId ?? null,
    desired_state: input.desiredState?.trim() || null,
    preparation_notes: input.preparationNotes?.trim() || null,
    reviewed: input.reviewed ?? false,
    created_by: input.createdBy ?? "proxy_ui",
    confidence: input.confidence ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabaseServer.from("execute_touchpoints").update(payload).eq("id", existing.id);
    if (error) throw new Error(`Could not update meeting enrichment: ${error.message}`);
    await recordTouchpointAudit({
      touchpointId: existing.id as string,
      calendarEventId: input.calendarEventId,
      notionPageId: input.notionPageId ?? null,
      source,
      previous: existing,
      next: payload,
    });
    return { id: existing.id as string, created: false };
  }

  const { data, error } = await supabaseServer.from("execute_touchpoints").insert(payload).select("id").single();
  if (error || !data) throw new Error(`Could not create meeting enrichment: ${error?.message ?? "Unknown error"}`);
  await recordTouchpointAudit({
    touchpointId: data.id as string,
    calendarEventId: input.calendarEventId,
    notionPageId: input.notionPageId ?? null,
    source,
    previous: { project_state_id: null, milestone_id: null, desired_state: null, preparation_notes: null, reviewed: false },
    next: payload,
  });
  return { id: data.id as string, created: true };
}

/**
 * Filtering by event id is capped deliberately: Outlook event ids are ~150
 * characters and PostgREST sends `in.(...)` in the query string, so a long
 * list produces a URL the API rejects. Past the cap, read the table whole and
 * filter in memory -- it holds one row per enriched meeting.
 */
const TOUCHPOINT_ID_FILTER_CAP = 25;

export async function listTouchpoints(calendarEventIds?: string[]): Promise<TouchpointRecord[]> {
  let query = supabaseServer
    .from("execute_touchpoints")
    .select("id, project_state_id, milestone_id, calendar_event_id, desired_state, preparation_notes, created_by");
  const filterable = calendarEventIds?.length && calendarEventIds.length <= TOUCHPOINT_ID_FILTER_CAP;
  if (filterable) query = query.in("calendar_event_id", calendarEventIds as string[]);

  const { data, error } = await query;
  if (error) throw new Error(`Could not load meeting enrichment: ${error.message}`);

  const wanted = calendarEventIds?.length && !filterable ? new Set(calendarEventIds) : null;

  return (data ?? [])
    .filter((row) => !wanted || wanted.has(row.calendar_event_id))
    .map((row) => ({
    id: row.id,
    projectStateId: row.project_state_id,
    milestoneId: row.milestone_id,
    calendarEventId: row.calendar_event_id,
    desiredState: row.desired_state,
    preparationNotes: row.preparation_notes,
    createdBy: row.created_by,
  }));
}
