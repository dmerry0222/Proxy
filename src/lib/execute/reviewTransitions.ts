/**
 * Pure state-transition logic for Reconciliation Review actions. No
 * imports, no I/O, so it's testable with plain node --test the same way
 * ownershipRules.ts/titleSimilarity.ts are -- reviewActions.ts (the server
 * dispatcher) calls these to decide *what* to write, then does the
 * writing itself.
 *
 * Every plan is idempotent-safe by construction: reviewActions.ts guards
 * the actual DB update with a status filter (e.g. .eq("status","candidate"))
 * so replaying the same action twice is a no-op on the second call, not a
 * duplicate transition.
 */

export type ItemPatch = Record<string, unknown>;

/**
 * A subset of reconciliation/types.ts's ReconciliationOutcome literals,
 * redeclared locally (not imported) so this file stays a zero-import leaf
 * module runnable directly via `node --experimental-strip-types --test`,
 * the same constraint that keeps calendarClassify.ts/titleSimilarity.ts
 * self-contained. Each literal here is a real ReconciliationOutcome value
 * -- keep in sync with that union if it changes.
 */
export type ReviewAuditOutcome = "cancel" | "complete" | "update_timing" | "associate_project" | "no_action" | "attach_evidence";

export type ReviewPlan = {
  itemPatch: ItemPatch | null;
  /** Which prior status the item must currently be in for this plan to apply -- the dispatcher's idempotency guard. */
  requireStatus: string[] | null;
  userOutcome: "confirmed" | "corrected" | "rejected" | null;
  /** Recorded as a fresh, user-authored reconciliation decision, or null if none is warranted. */
  auditOutcome: ReviewAuditOutcome | null;
  auditReasoning: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

export function isOverdue(expectedAt: string | null, now: Date = new Date()): boolean {
  return Boolean(expectedAt) && new Date(expectedAt as string).getTime() < now.getTime();
}

export function planAcceptCandidate(): ReviewPlan {
  return {
    itemPatch: { status: "active", confirmed_by_user: true },
    requireStatus: ["candidate"],
    userOutcome: "confirmed",
    auditOutcome: null,
    auditReasoning: null,
  };
}

export function planRejectCandidate(reason: "not_a_task" | "not_mine"): ReviewPlan {
  return {
    itemPatch: { status: "cancelled", cancelled_at: nowIso() },
    requireStatus: ["candidate"],
    userOutcome: "rejected",
    auditOutcome: "cancel",
    auditReasoning: reason === "not_a_task"
      ? "Dave rejected this candidate: not a task."
      : "Dave rejected this candidate: not his to own.",
  };
}

export function planMarkAlreadyDone(): ReviewPlan {
  return {
    itemPatch: { status: "completed", completed_at: nowIso() },
    requireStatus: ["candidate"],
    userOutcome: "corrected",
    auditOutcome: "complete",
    auditReasoning: "Dave indicated this was already done before it was ever accepted.",
  };
}

export function planTrackWaiting(): ReviewPlan {
  return {
    itemPatch: { status: "active", confirmed_by_user: true },
    requireStatus: ["candidate"],
    userOutcome: "confirmed",
    auditOutcome: null,
    auditReasoning: null,
  };
}

export function planResolveExternal(): ReviewPlan {
  return {
    itemPatch: { status: "completed", completed_at: nowIso() },
    requireStatus: ["candidate", "active"],
    userOutcome: null,
    auditOutcome: "complete",
    auditReasoning: "Dave marked this external obligation as delivered.",
  };
}

export function planExternalNotRelevant(): ReviewPlan {
  return {
    itemPatch: { status: "cancelled", cancelled_at: nowIso() },
    requireStatus: ["candidate", "active"],
    userOutcome: "rejected",
    auditOutcome: "cancel",
    auditReasoning: "Dave marked this external obligation as not relevant.",
  };
}

export function planCorrectExternalOwner(relatedPersonEntityId: string): ReviewPlan {
  return {
    itemPatch: { related_person_entity_id: relatedPersonEntityId },
    requireStatus: ["candidate", "active"],
    userOutcome: "corrected",
    auditOutcome: "no_action",
    auditReasoning: "Dave corrected who this external obligation is waiting on.",
  };
}

export function planEditExpectedAt(expectedAt: string): ReviewPlan {
  return {
    itemPatch: { expected_at: expectedAt },
    requireStatus: ["candidate", "active"],
    userOutcome: "corrected",
    auditOutcome: "no_action",
    auditReasoning: `Dave corrected the expected date to ${expectedAt}.`,
  };
}

export function planEditItem(input: {
  title?: string;
  timingAt?: string | null;
  timingKind?: "must" | "target" | null;
  projectStateId?: string | null;
}): ReviewPlan {
  const itemPatch: ItemPatch = {};
  const changes: string[] = [];
  let auditOutcome: ReviewAuditOutcome | null = null;

  if (input.title) {
    itemPatch.title = input.title;
    changes.push("title");
  }
  if (input.timingAt !== undefined) {
    itemPatch.timing_at = input.timingAt;
    itemPatch.timing_kind = input.timingAt ? (input.timingKind ?? "target") : null;
    changes.push("timing");
    auditOutcome = "update_timing";
  }
  if (input.projectStateId !== undefined) {
    itemPatch.project_state_id = input.projectStateId;
    changes.push("project");
    auditOutcome = auditOutcome ?? "associate_project";
  }

  if (!changes.length) {
    return { itemPatch: null, requireStatus: null, userOutcome: null, auditOutcome: null, auditReasoning: null };
  }

  return {
    itemPatch,
    requireStatus: null,
    userOutcome: "corrected",
    auditOutcome: auditOutcome ?? "no_action",
    auditReasoning: `Dave corrected ${changes.join(", ")}.`,
  };
}

export function planConfirmCompletion(): ReviewPlan {
  return {
    itemPatch: { status: "completed", completed_at: nowIso() },
    requireStatus: ["candidate", "active", "deferred"],
    userOutcome: "confirmed",
    auditOutcome: "complete",
    auditReasoning: "Dave confirmed this item is complete.",
  };
}

export function planRejectCompletion(): ReviewPlan {
  return { itemPatch: null, requireStatus: null, userOutcome: "rejected", auditOutcome: null, auditReasoning: null };
}

export function planConfirmCancellation(): ReviewPlan {
  return {
    itemPatch: { status: "cancelled", cancelled_at: nowIso() },
    requireStatus: ["candidate", "active", "deferred"],
    userOutcome: "confirmed",
    auditOutcome: "cancel",
    auditReasoning: "Dave confirmed this item should be cancelled.",
  };
}

export function planRejectCancellation(): ReviewPlan {
  return { itemPatch: null, requireStatus: null, userOutcome: "rejected", auditOutcome: null, auditReasoning: null };
}

export function planDeferCancellation(deferredUntil: string | null): ReviewPlan {
  return {
    itemPatch: { status: "deferred", deferred_until: deferredUntil },
    requireStatus: ["candidate", "active"],
    userOutcome: "corrected",
    auditOutcome: "no_action",
    auditReasoning: "Dave deferred this item instead of cancelling it.",
  };
}

export function planResolveAmbiguousDifferent(): ReviewPlan {
  return {
    itemPatch: null,
    requireStatus: null,
    userOutcome: "rejected",
    auditOutcome: "no_action",
    auditReasoning: "Dave confirmed this evidence describes different work; no merge performed.",
  };
}
