import type { WorkBlockChecklistItem, WorkBlockStatus } from "@/lib/execute/types";

export function requireString(value: unknown, name: string, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${name} is required and must be at most ${max} characters`);
  }
  return value.trim();
}

export function optionalUuid(value: unknown, name: string) {
  if (value == null || value === "") return null;
  const text = requireString(value, name, 50);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error(`${name} must be a UUID`);
  }
  return text;
}

export function requireTimestamp(value: unknown, name: string) {
  const text = requireString(value, name, 50);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date.toISOString();
}

export function parseChecklist(value: unknown): WorkBlockChecklistItem[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("checklist must be an array of at most 20 items");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid checklist item");
    const item = entry as Record<string, unknown>;
    return {
      id: typeof item.id === "string" && item.id ? item.id.slice(0, 80) : `step-${index + 1}`,
      label: requireString(item.label, "checklist label", 240),
      checked: item.checked === true,
    };
  });
}

export function parseWorkBlockOutcome(value: unknown): Extract<WorkBlockStatus, "completed" | "partial" | "missed"> {
  if (value !== "completed" && value !== "partial" && value !== "missed") {
    throw new Error("outcome must be completed, partial, or missed");
  }
  return value;
}

