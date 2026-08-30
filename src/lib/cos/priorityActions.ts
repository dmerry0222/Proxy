import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { optionalUuid, requireTimestamp } from "@/lib/execute/validation";
import { validatePriorityDirective, type RawDirective, type ValidatedDirective } from "@/lib/cos/priorityDirective";
import { runPriorityAssessment } from "@/lib/cos/runPriorityAssessment";

type PriorityAction =
  | { action: "set_tier"; itemId?: unknown; tier?: unknown }
  | { action: "set_protection"; itemId?: unknown; protection?: unknown }
  | { action: "mark_not_now"; itemId?: unknown }
  | { action: "defer_item"; itemId?: unknown; deferredUntil?: unknown }
  | { action: "pin_until"; itemId?: unknown; tier?: unknown; protection?: unknown; until?: unknown }
  | { action: "force_reassessment"; itemId?: unknown }
  | { action: "clear_directive"; itemId?: unknown };

type ItemRow = { id: string; timing_at: string | null; timing_kind: "must" | "target" | null; priority_directive: unknown };

async function loadItem(itemId: string): Promise<ItemRow> {
  const { data, error } = await supabaseServer.from("execution_items").select("id, timing_at, timing_kind, priority_directive").eq("id", itemId).maybeSingle();
  if (error) throw new Error(`Could not load item: ${error.message}`);
  if (!data) throw new Error("Item was not found");
  return data as ItemRow;
}

/** A manual override starts from whatever the current directive already says and patches only what Dave changed -- never invents unrelated fields. */
function buildManualPatch(current: unknown, patch: Partial<RawDirective>): RawDirective {
  const base = current && typeof current === "object" ? (current as RawDirective) : {};
  return {
    tier: base.tier ?? "P3",
    why: base.why ?? "Manually set by Dave.",
    desiredOutcome: base.desiredOutcome,
    hardness: base.hardness ?? "moderate",
    protection: base.protection ?? "normal",
    mayDisplace: base.mayDisplace ?? ["background"],
    attentionPriority: base.attentionPriority,
    escalationCondition: base.escalationCondition,
    ...patch,
    source: "manual",
    decidedAt: new Date().toISOString(),
  };
}

async function writeDirective(itemId: string, directive: ValidatedDirective): Promise<void> {
  const { error } = await supabaseServer.from("execution_items").update({ priority_directive: directive, updated_at: new Date().toISOString() }).eq("id", itemId);
  if (error) throw new Error(`Could not save priority override: ${error.message}`);
}

export async function applyPriorityAction(input: PriorityAction): Promise<{ ok: true }> {
  if (!input || typeof input !== "object" || typeof (input as { action?: unknown }).action !== "string") {
    throw new Error("A valid action is required");
  }

  switch (input.action) {
    case "set_tier": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      if (input.tier !== "P1" && input.tier !== "P2" && input.tier !== "P3" && input.tier !== "background") throw new Error("Invalid tier");
      const item = await loadItem(itemId);
      const raw = buildManualPatch(item.priority_directive, { tier: input.tier });
      const validated = validatePriorityDirective(raw, { timingAt: item.timing_at, timingKind: item.timing_kind });
      if (!validated.ok) throw new Error(validated.reason);
      await writeDirective(itemId, validated.directive);
      break;
    }
    case "set_protection": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      if (input.protection !== "protected" && input.protection !== "normal" && input.protection !== "flexible") throw new Error("Invalid protection");
      const item = await loadItem(itemId);
      const raw = buildManualPatch(item.priority_directive, { protection: input.protection });
      const validated = validatePriorityDirective(raw, { timingAt: item.timing_at, timingKind: item.timing_kind });
      if (!validated.ok) throw new Error(validated.reason);
      await writeDirective(itemId, validated.directive);
      break;
    }
    case "mark_not_now": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      const item = await loadItem(itemId);
      const raw = buildManualPatch(item.priority_directive, {
        tier: "background",
        why: "Dave marked this as not-now.",
        protection: "flexible",
        mayDisplace: ["P2", "P3", "background"],
      });
      const validated = validatePriorityDirective(raw, { timingAt: item.timing_at, timingKind: item.timing_kind });
      if (!validated.ok) throw new Error(validated.reason);
      await writeDirective(itemId, validated.directive);
      break;
    }
    case "pin_until": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      const until = requireTimestamp(input.until, "until");
      const item = await loadItem(itemId);
      const patch: Partial<RawDirective> = { reassessAt: until };
      if (input.tier === "P1" || input.tier === "P2" || input.tier === "P3" || input.tier === "background") patch.tier = input.tier;
      if (input.protection === "protected" || input.protection === "normal" || input.protection === "flexible") patch.protection = input.protection;
      const raw = buildManualPatch(item.priority_directive, patch);
      const validated = validatePriorityDirective(raw, { timingAt: item.timing_at, timingKind: item.timing_kind });
      if (!validated.ok) throw new Error(validated.reason);
      await writeDirective(itemId, validated.directive);
      break;
    }
    case "defer_item": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      const deferredUntil = requireTimestamp(input.deferredUntil, "deferredUntil");
      const { error } = await supabaseServer
        .from("execution_items")
        .update({ status: "deferred", deferred_until: deferredUntil, updated_at: new Date().toISOString() })
        .eq("id", itemId)
        .in("status", ["active", "candidate"]);
      if (error) throw new Error(`Could not defer item: ${error.message}`);
      break;
    }
    case "force_reassessment": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      const item = await loadItem(itemId);
      // If the current directive is a manual override, it would otherwise
      // block the very reassessment being requested here -- expiring it
      // is the whole point of "force reassessment" (Part 11).
      if (item.priority_directive && typeof item.priority_directive === "object" && (item.priority_directive as RawDirective).source === "manual") {
        const raw = buildManualPatch(item.priority_directive, { reassessAt: new Date().toISOString() });
        const validated = validatePriorityDirective(raw, { timingAt: item.timing_at, timingKind: item.timing_kind });
        if (validated.ok) await writeDirective(itemId, validated.directive);
      }
      await runPriorityAssessment({ trigger: "manual_request", scope: "item", scopeRef: itemId });
      break;
    }
    case "clear_directive": {
      const itemId = optionalUuid(input.itemId, "itemId");
      if (!itemId) throw new Error("itemId is required");
      const { error } = await supabaseServer.from("execution_items").update({ priority_directive: null, updated_at: new Date().toISOString() }).eq("id", itemId);
      if (error) throw new Error(`Could not clear priority directive: ${error.message}`);
      break;
    }
    default:
      throw new Error("Unsupported priority action");
  }

  return { ok: true };
}
