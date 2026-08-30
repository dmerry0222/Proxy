/**
 * Deterministic prioritization policy (Post-Phase-6 Part 4/15/19) -- pure,
 * zero-import leaf module. Used both as the conservative fallback when no
 * model is available/its output is rejected, and as the basis the model
 * (when used) is asked to refine rather than invent from nothing.
 *
 * Deliberately conservative: hard timing or overdue state alone does not
 * imply P1 (Part 3) -- only genuine overdue-ness or strong project
 * association moves the deterministic default up from P3.
 */

import type { PrioritySignals } from "./computeSignals";
import type { RawDirective } from "./priorityDirective";

const DEFAULT_REASSESS_DAYS = 7;

function addDays(date: Date, days: number): string {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy.toISOString();
}

export function deterministicDirectiveFallback(
  signals: PrioritySignals,
  timingAt: string | null,
  timingKind: "must" | "target" | null,
  now: Date = new Date()
): RawDirective {
  const timing = timingAt && timingKind ? { kind: timingKind, at: timingAt } : undefined;

  if (signals.isOverdue && signals.hasHardTiming) {
    return {
      tier: "P1",
      why: "Past its hard deadline.",
      timing,
      hardness: "hard",
      protection: "protected",
      mayDisplace: [],
      attentionPriority: "high",
      reassessAt: addDays(now, 1),
      escalationCondition: "Escalate if still open tomorrow.",
      source: "cos",
      decidedAt: now.toISOString(),
    };
  }

  if (signals.hasProject && signals.projectTier === "P1") {
    return {
      tier: "P2",
      why: signals.projectWhy ? `Part of a protected project: ${signals.projectWhy}` : "Part of a currently protected project.",
      timing,
      hardness: signals.hasHardTiming ? "hard" : "moderate",
      protection: "normal",
      mayDisplace: ["P3", "background"],
      reassessAt: addDays(now, DEFAULT_REASSESS_DAYS),
      source: "cos",
      decidedAt: now.toISOString(),
    };
  }

  if (signals.hasHardTiming) {
    return {
      tier: "P3",
      why: "Has a fixed deadline but no other elevated importance signal yet.",
      timing,
      hardness: "hard",
      protection: "normal",
      mayDisplace: ["background"],
      reassessAt: addDays(now, DEFAULT_REASSESS_DAYS),
      source: "cos",
      decidedAt: now.toISOString(),
    };
  }

  return {
    tier: "P3",
    why: "No elevated urgency or importance signal yet.",
    timing,
    hardness: "soft",
    protection: "flexible",
    mayDisplace: ["background"],
    reassessAt: addDays(now, DEFAULT_REASSESS_DAYS),
    source: "cos",
    decidedAt: now.toISOString(),
  };
}

export type OverloadResult = { overloaded: boolean; count: number; reason: string | null };

/**
 * "The current priority picture is impossible" (Part 19) -- deliberately
 * simple: too many simultaneously protected P1 items. This phase does not
 * attempt capacity math; it only flags the picture as incoherent so a
 * human resolves it via review, never silently downgrading anything.
 */
export function detectOverload(directives: Array<{ tier: string; protection: string }>, threshold = 5): OverloadResult {
  const protectedP1Count = directives.filter((entry) => entry.tier === "P1" && entry.protection === "protected").length;
  if (protectedP1Count > threshold) {
    return { overloaded: true, count: protectedP1Count, reason: `${protectedP1Count} items are simultaneously protected P1, more than can realistically be protected at once.` };
  }
  return { overloaded: false, count: protectedP1Count, reason: null };
}

/**
 * Which active-work items are actually worth spending a prioritization
 * pass on (Part 15/16) -- avoids rerunning CoS over settled, unchanged
 * work on every trigger.
 */
export function needsReassessment(signals: PrioritySignals): { needed: boolean; reason: string } {
  if (!signals.hasExistingDirective) return { needed: true, reason: "No directive exists yet." };
  if (signals.existingDirectiveSource === "manual") return { needed: false, reason: "Active manual override." };
  if (signals.existingDirectiveIsStale) return { needed: true, reason: "Directive is past its reassessAt date." };
  if (signals.isOverdue && signals.existingTier !== "P1") return { needed: true, reason: "Item became overdue since its last directive." };
  return { needed: false, reason: "Directive is still current." };
}
