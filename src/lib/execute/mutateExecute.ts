import "server-only";

import { buildWorkBlockCalendarPayload } from "@/lib/execute/calendarProvider";
import { supabaseServer } from "@/lib/supabase/server";
import {
  optionalUuid,
  parseChecklist,
  parseWorkBlockOutcome,
  requireString,
  requireTimestamp,
} from "@/lib/execute/validation";

type ExecuteMutation =
  | { action: "activate_project"; memoryProjectEntityId?: unknown; nextPlateau?: unknown }
  | { action: "create_item"; projectStateId?: unknown; title?: unknown; description?: unknown; effortMinutes?: unknown }
  | { action: "create_block"; title?: unknown; start?: unknown; end?: unknown; itemIds?: unknown; checklist?: unknown }
  | { action: "record_block_outcome"; workBlockId?: unknown; outcome?: unknown; completedItemIds?: unknown; note?: unknown; checklist?: unknown };

function positiveMinutes(value: unknown) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 24 * 60) {
    throw new Error("effortMinutes must be a positive integer no greater than 1440");
  }
  return parsed;
}

function uuidList(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${name} must contain between 1 and 20 IDs`);
  }
  return [...new Set(value.map((entry) => optionalUuid(entry, name)!))];
}

async function activateProject(input: Extract<ExecuteMutation, { action: "activate_project" }>) {
  const memoryProjectEntityId = optionalUuid(input.memoryProjectEntityId, "memoryProjectEntityId");
  if (!memoryProjectEntityId) throw new Error("memoryProjectEntityId is required");
  const nextPlateau = requireString(input.nextPlateau, "nextPlateau", 500);
  const { data: entity, error: entityError } = await supabaseServer.from("memory_entities")
    .select("id").eq("id", memoryProjectEntityId).eq("entity_type", "project").neq("status", "merged").single();
  if (entityError || !entity) throw new Error("The selected Memory project does not exist");
  const { data, error } = await supabaseServer.from("execute_project_states").upsert({
    memory_project_entity_id: memoryProjectEntityId,
    status: "active",
    next_plateau: nextPlateau,
    completed_at: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "memory_project_entity_id" }).select("id").single();
  if (error || !data) throw new Error(`Could not activate project: ${error?.message ?? "Unknown error"}`);
  return { projectStateId: data.id };
}

async function createItem(input: Extract<ExecuteMutation, { action: "create_item" }>) {
  const projectStateId = optionalUuid(input.projectStateId, "projectStateId");
  const title = requireString(input.title, "title", 300);
  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.trim().slice(0, 2000) : null;
  const { data, error } = await supabaseServer.from("execution_items").insert({
    project_state_id: projectStateId,
    title,
    description,
    status: "active",
    responsibility: "mine",
    effort_minutes: positiveMinutes(input.effortMinutes),
    confirmed_by_user: true,
    extraction_basis: "execute_manual",
    metadata: { created_from: "execute" },
  }).select("id").single();
  if (error || !data) throw new Error(`Could not create execution item: ${error?.message ?? "Unknown error"}`);
  return { executionItemId: data.id };
}

async function createBlock(input: Extract<ExecuteMutation, { action: "create_block" }>) {
  const title = requireString(input.title, "title", 300);
  const start = requireTimestamp(input.start, "start");
  const end = requireTimestamp(input.end, "end");
  if (new Date(end) <= new Date(start)) throw new Error("Work block end must be after its start");
  if (new Date(end).getTime() - new Date(start).getTime() > 8 * 60 * 60 * 1000) {
    throw new Error("A work block cannot exceed eight hours");
  }
  const itemIds = uuidList(input.itemIds, "itemIds");
  const checklist = parseChecklist(input.checklist ?? []);

  const [{ data: items, error: itemError }, { data: conflicts, error: conflictError }] = await Promise.all([
    supabaseServer.from("execution_items").select("id").in("id", itemIds).eq("status", "active"),
    supabaseServer.from("calendar_events").select("event_id").lt("start_time", end).gt("end_time", start).neq("show_as", "free").limit(1),
  ]);
  if (itemError || (items ?? []).length !== itemIds.length) throw new Error("Every selected item must exist and be active");
  if (conflictError) throw new Error(`Could not validate calendar capacity: ${conflictError.message}`);
  if ((conflicts ?? []).length) throw new Error("That time overlaps a busy Outlook event");

  const { data: blockConflicts, error: blockConflictError } = await supabaseServer.from("execute_work_blocks")
    .select("id").lt("planned_start", end).gt("planned_end", start)
    .in("status", ["proposed", "committed"]).limit(1);
  if (blockConflictError) throw new Error(`Could not validate work blocks: ${blockConflictError.message}`);
  if ((blockConflicts ?? []).length) throw new Error("That time overlaps another active work block");

  const providerRequestId = crypto.randomUUID();
  const { data: block, error: blockError } = await supabaseServer.from("execute_work_blocks").insert({
    title, status: "committed", planned_start: start, planned_end: end,
    provider_request_id: providerRequestId, checklist,
  }).select("id").single();
  if (blockError || !block) throw new Error(`Could not create work block: ${blockError?.message ?? "Unknown error"}`);

  const duration = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  const perItem = Math.max(1, Math.floor(duration / itemIds.length));
  const { error: linkError } = await supabaseServer.from("execute_work_block_items").insert(
    itemIds.map((executionItemId, position) => ({
      work_block_id: block.id,
      execution_item_id: executionItemId,
      allocated_minutes: perItem,
      position,
    })));
  if (linkError) {
    await supabaseServer.from("execute_work_blocks").delete().eq("id", block.id);
    throw new Error(`Could not attach items to work block: ${linkError.message}`);
  }

  const payload = buildWorkBlockCalendarPayload({ workBlockId: block.id, title, start, end, checklist });
  const { error: outboxError } = await supabaseServer.from("execute_calendar_outbox").insert({
    work_block_id: block.id,
    operation: "create",
    idempotency_key: providerRequestId,
    payload,
  });
  if (outboxError) throw new Error(`Work block was saved but calendar handoff failed: ${outboxError.message}`);
  return { workBlockId: block.id, calendarHandoff: "pending" };
}

async function recordBlockOutcome(input: Extract<ExecuteMutation, { action: "record_block_outcome" }>) {
  const workBlockId = optionalUuid(input.workBlockId, "workBlockId");
  if (!workBlockId) throw new Error("workBlockId is required");
  const outcome = parseWorkBlockOutcome(input.outcome);
  const completedItemIds = input.completedItemIds == null || (Array.isArray(input.completedItemIds) && input.completedItemIds.length === 0)
    ? [] : uuidList(input.completedItemIds, "completedItemIds");
  const checklist = parseChecklist(input.checklist ?? []);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 2000) : null;
  const { data: links, error: linkError } = await supabaseServer.from("execute_work_block_items")
    .select("execution_item_id").eq("work_block_id", workBlockId);
  if (linkError || !links?.length) throw new Error("Work block not found");
  const linkedIds = new Set(links.map((link) => link.execution_item_id));
  const idsToComplete = outcome === "completed" ? [...linkedIds] : completedItemIds;
  if (idsToComplete.some((id) => !linkedIds.has(id))) throw new Error("Only items in this block can be completed");

  const now = new Date().toISOString();
  const { data: block, error: blockError } = await supabaseServer.from("execute_work_blocks").update({
    status: outcome, checklist, completion_note: note, updated_at: now,
  }).eq("id", workBlockId).in("status", ["proposed", "committed"]).select("id").single();
  if (blockError || !block) throw new Error("Work block is no longer open");
  if (idsToComplete.length) {
    const { error: itemError } = await supabaseServer.from("execution_items").update({
      status: "completed", completed_at: now, updated_at: now,
    }).in("id", idsToComplete).eq("status", "active");
    if (itemError) throw new Error(`Block saved, but item completion failed: ${itemError.message}`);
  }
  return { workBlockId, completedItemIds: idsToComplete };
}

export async function applyExecuteMutation(input: ExecuteMutation) {
  if (!input || typeof input !== "object" || typeof input.action !== "string") throw new Error("A valid action is required");
  switch (input.action) {
    case "activate_project": return activateProject(input);
    case "create_item": return createItem(input);
    case "create_block": return createBlock(input);
    case "record_block_outcome": return recordBlockOutcome(input);
    default: throw new Error("Unsupported Execute action");
  }
}

