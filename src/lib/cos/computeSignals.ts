/**
 * Deterministic input signals for prioritization (Post-Phase-6 Part 4) --
 * pure, zero-import leaf module. These facts are computed from operational
 * state alone; the model (if used) reasons over this compact packet, never
 * over raw source material, and never overrides any fact computed here.
 */

export type ItemForSignals = {
  id: string;
  title: string;
  status: "candidate" | "active" | "completed" | "cancelled" | "deferred";
  responsibility: "mine" | "external";
  confirmedByUser: boolean;
  timingAt: string | null;
  timingKind: "must" | "target" | null;
  deferredUntil: string | null;
  waitingSince: string | null;
  expectedAt: string | null;
  projectStateId: string | null;
  currentDirective: { tier: string; source: string; reassessAt?: string; decidedAt: string } | null;
  pendingAttentionCount: number;
};

export type ProjectForSignals = {
  id: string;
  status: "active" | "operationally_complete" | "inactive";
  currentDirective: { tier: string; why: string } | null;
};

export type PrioritySignals = {
  itemId: string;
  statusCategory: "candidate" | "active" | "deferred" | "terminal";
  isConfirmed: boolean;
  responsibility: "mine" | "external";
  hasHardTiming: boolean;
  daysUntilTiming: number | null;
  isOverdue: boolean;
  isBlockedOnOthers: boolean;
  hasProject: boolean;
  projectTier: string | null;
  projectWhy: string | null;
  hasPendingReview: boolean;
  hasExistingDirective: boolean;
  existingTier: string | null;
  existingDirectiveSource: string | null;
  existingDirectiveIsStale: boolean;
};

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function computeItemSignals(item: ItemForSignals, project: ProjectForSignals | null, now: Date = new Date()): PrioritySignals {
  const statusCategory =
    item.status === "candidate" ? "candidate"
    : item.status === "active" ? "active"
    : item.status === "deferred" ? "deferred"
    : "terminal";

  const daysUntilTiming = item.timingAt ? daysBetween(now, new Date(item.timingAt)) : null;

  const existingDirectiveIsStale = Boolean(
    item.currentDirective?.reassessAt && new Date(item.currentDirective.reassessAt).getTime() <= now.getTime()
  );

  return {
    itemId: item.id,
    statusCategory,
    isConfirmed: item.confirmedByUser,
    responsibility: item.responsibility,
    hasHardTiming: item.timingKind === "must",
    daysUntilTiming,
    isOverdue: daysUntilTiming !== null && daysUntilTiming < 0,
    isBlockedOnOthers: item.responsibility === "external" && item.status === "active",
    hasProject: Boolean(item.projectStateId),
    projectTier: project?.currentDirective?.tier ?? null,
    projectWhy: project?.currentDirective?.why ?? null,
    hasPendingReview: item.pendingAttentionCount > 0,
    hasExistingDirective: Boolean(item.currentDirective),
    existingTier: item.currentDirective?.tier ?? null,
    existingDirectiveSource: item.currentDirective?.source ?? null,
    existingDirectiveIsStale,
  };
}

/**
 * Whether this item is even eligible for an execution-priority directive
 * at all (Part 5/6/20): only confirmed, active, Dave-owned work. Candidates
 * get review attention, not execution priority; external work gets
 * attention priority via the existing waiting/overdue mechanism, never a
 * directive implying Dave should spend execution time on it.
 */
export function isEligibleForExecutionDirective(signals: PrioritySignals): boolean {
  return signals.statusCategory === "active" && signals.responsibility === "mine" && signals.isConfirmed;
}
