import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { resolveProjectTitle } from "@/lib/execute/projects";
import type {
  ExecuteDashboard,
  ExecuteItem,
  ExecuteProject,
  WorkBlockChecklistItem,
} from "@/lib/execute/types";

function isChecklist(value: unknown): value is WorkBlockChecklistItem[] {
  return Array.isArray(value) && value.every((item) =>
    item && typeof item === "object" && typeof item.id === "string" &&
    typeof item.label === "string" && typeof item.checked === "boolean");
}

function attendeesIncludeOthers(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

export async function loadExecuteDashboard(): Promise<ExecuteDashboard> {
  const horizonStart = new Date();
  horizonStart.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(horizonStart);
  horizonEnd.setDate(horizonEnd.getDate() + 28);

  const [projectResult, memoryProjectResult, itemResult, blockResult, eventResult, touchpointResult] = await Promise.all([
    /*
     * LEFT join: a Project no longer requires a Memory entity, so !inner
     * would silently hide every project created in Execute or in Notion.
     */
    supabaseServer.from("execute_project_states")
      .select("id, memory_project_entity_id, title, next_plateau, priority_directive, memory_entities!execute_project_states_memory_project_entity_id_fkey(canonical_name)")
      .eq("status", "active").order("updated_at", { ascending: false }),
    supabaseServer.from("memory_entities").select("id, canonical_name")
      .eq("entity_type", "project").neq("status", "merged").order("canonical_name"),
    supabaseServer.from("execution_items")
      .select("id, project_state_id, title, description, status, responsibility, confirmed_by_user, effort_minutes, timing_kind, timing_at, critical_rank, waiting_since, expected_at, related_person_entity_id, deferred_until, priority_directive, execute_project_states(memory_entities!execute_project_states_memory_project_entity_id_fkey(canonical_name)), execute_work_block_items(allocated_minutes, execute_work_blocks!inner(status))")
      .in("status", ["candidate", "active", "deferred"]).order("created_at", { ascending: true }),
    supabaseServer.from("execute_work_blocks")
      .select("id, title, status, planned_start, planned_end, calendar_event_id, checklist, completion_note, calendar_events(start_time, end_time), execute_work_block_items(allocated_minutes, position, execution_items(id, title, status))")
      .gte("planned_end", horizonStart.toISOString()).lte("planned_start", horizonEnd.toISOString())
      .neq("status", "cancelled").order("planned_start"),
    supabaseServer.from("calendar_events")
      .select("event_id, subject, start_time, end_time, show_as, attendees")
      .gte("end_time", horizonStart.toISOString()).lte("start_time", horizonEnd.toISOString())
      .order("start_time"),
    supabaseServer.from("execute_touchpoints").select("calendar_event_id"),
  ]);

  const firstError = [projectResult, memoryProjectResult, itemResult, blockResult, eventResult, touchpointResult]
    .find((result) => result.error)?.error;
  if (firstError) throw new Error(`Could not load Execute: ${firstError.message}`);

  const projectNames = new Map<string, string>();
  const projects = (projectResult.data ?? []).map((row) => {
    const project: ExecuteProject = {
      id: row.id,
      memoryProjectEntityId: row.memory_project_entity_id,
      name: resolveProjectTitle(row),
      nextPlateau: row.next_plateau,
      priorityDirective: row.priority_directive as ExecuteProject["priorityDirective"],
    };
    projectNames.set(project.id, project.name);
    return project;
  });

  const touchpointIds = new Set((touchpointResult.data ?? []).map((row) => row.calendar_event_id));

  const relatedPersonIds = [...new Set((itemResult.data ?? []).map((row) => row.related_person_entity_id).filter((id): id is string => Boolean(id)))];
  const { data: relatedPeople, error: relatedPeopleError } = relatedPersonIds.length
    ? await supabaseServer.from("memory_entities").select("id, canonical_name").in("id", relatedPersonIds)
    : { data: [] as { id: string; canonical_name: string }[], error: null };
  if (relatedPeopleError) throw new Error(`Could not load related people: ${relatedPeopleError.message}`);
  const relatedPersonNames = new Map((relatedPeople ?? []).map((person) => [person.id, person.canonical_name]));

  return {
    horizonStart: horizonStart.toISOString(),
    horizonEnd: horizonEnd.toISOString(),
    projects,
    availableMemoryProjects: (memoryProjectResult.data ?? [])
      .filter((entity) => !projects.some((project) => project.memoryProjectEntityId === entity.id))
      .map((entity) => ({ id: entity.id, name: entity.canonical_name })),
    items: (itemResult.data ?? []).map((row) => ({
      id: row.id,
      projectStateId: row.project_state_id,
      projectName: row.project_state_id ? projectNames.get(row.project_state_id) ?? null : null,
      title: row.title,
      description: row.description,
      status: row.status,
      responsibility: row.responsibility,
      effortMinutes: row.effort_minutes,
      timingKind: row.timing_kind,
      timingAt: row.timing_at,
      criticalRank: row.critical_rank,
      waitingSince: row.waiting_since,
      expectedAt: row.expected_at,
      relatedPersonName: row.related_person_entity_id ? relatedPersonNames.get(row.related_person_entity_id) ?? null : null,
      confirmedByUser: row.confirmed_by_user,
      deferredUntil: row.deferred_until,
      priorityDirective: row.priority_directive as ExecuteItem["priorityDirective"],
      allocatedMinutes: (row.execute_work_block_items ?? []).reduce((total, link) => {
        const linkedBlock = Array.isArray(link.execute_work_blocks)
          ? link.execute_work_blocks[0]
          : link.execute_work_blocks;
        return linkedBlock?.status === "cancelled" ? total : total + (link.allocated_minutes ?? 0);
      }, 0),
    })),
    workBlocks: (blockResult.data ?? []).map((row) => {
      const external = Array.isArray(row.calendar_events) ? row.calendar_events[0] : row.calendar_events;
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        start: external?.start_time ?? row.planned_start,
        end: external?.end_time ?? row.planned_end,
        calendarEventId: row.calendar_event_id,
        checklist: isChecklist(row.checklist) ? row.checklist : [],
        completionNote: row.completion_note,
        items: (row.execute_work_block_items ?? [])
          .sort((a, b) => a.position - b.position)
          .flatMap((link) => {
            const item = Array.isArray(link.execution_items) ? link.execution_items[0] : link.execution_items;
            return item ? [{ id: item.id, title: item.title, status: item.status, allocatedMinutes: link.allocated_minutes }] : [];
          }),
      };
    }),
    calendarEvents: (eventResult.data ?? []).flatMap((row) =>
      row.start_time && row.end_time ? [{
        id: row.event_id,
        subject: row.subject ?? "Busy",
        start: row.start_time,
        end: row.end_time,
        showAs: row.show_as,
        hasOtherPeople: attendeesIncludeOthers(row.attendees),
        isTouchpoint: touchpointIds.has(row.event_id),
      }] : []),
  };
}
