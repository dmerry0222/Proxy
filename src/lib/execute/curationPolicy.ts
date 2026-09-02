/**
 * Pure, zero-import leaf module (same shape as claimReviewPolicy.ts /
 * pendingContextReviewPolicy.ts) deciding whether an execution item belongs
 * in CURATED EXECUTE -- the day-to-day surface -- or only in ALL EXECUTION
 * ITEMS, the trust/audit view.
 *
 * The point of this file is that curation is LEGIBLE, not magical. Every
 * outcome carries a sentence Dave can read on the item itself, in both
 * directions: why it surfaced, and why it was held back. Nothing is deleted
 * or hidden -- suppression only means "not in the curated view", and the
 * "everything Proxy knows" view still lists it with its reason attached.
 *
 * This is NOT prioritization. A future Chief of Staff decides what matters
 * (priority_directive: tier, hardness, protection, displacement...); this
 * decides only whether an item is worth showing right now, and it READS the
 * tier rather than inventing one. When no directive exists yet -- which is
 * every item today, since no CoS run has ever executed -- curation falls back
 * to observable facts: dates, confirmation, source, and age.
 */

export type CurationInput = {
  status: string;
  responsibility: string;
  /** From priority_directive->>'tier'; null until a CoS run assigns one. */
  priorityTier: string | null;
  confirmedByUser: boolean;
  /** Due/target date the world imposes. */
  timingAt: string | null;
  timingKind: string | null;
  /** Dave's manual planning date, moved by hand in Notion. */
  plannedAt: string | null;
  deferredUntil: string | null;
  expectedAt: string | null;
  waitingOnName: string | null;
  sourceSystem: string | null;
  sourceWithdrawnAt: string | null;
  projectStateId: string | null;
  createdAt: string;
  /**
   * When the underlying source record actually happened (the email's
   * received date, the meeting's date). Age is measured from this, not from
   * when Proxy got around to creating the row -- otherwise backfilling a
   * year of mail would make every item look brand new at once.
   */
  sourceOccurredAt?: string | null;
  now?: Date;
};

export type CurationResult = {
  curated: boolean;
  whySurfaced: string | null;
  whySuppressed: string | null;
};

/**
 * How long an unconfirmed, undated, unowned extraction stays in the curated
 * view on the strength of being new. Past this it is still fully visible in
 * ALL EXECUTION ITEMS, with the reason written on it -- 166 unreviewed
 * candidate items exist today, and a curated view that shows all of them
 * teaches Dave nothing about what Proxy actually thinks.
 */
export const UNCONFIRMED_GRACE_DAYS = 14;

/** How far ahead a due date pulls an item into the curated view. */
export const DUE_HORIZON_DAYS = 21;

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function parse(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function shortDate(value: string): string {
  const date = parse(value);
  if (!date) return value;
  return date.toISOString().slice(0, 10);
}

export function assessCuration(input: CurationInput): CurationResult {
  const now = input.now ?? new Date();

  const suppressed = (reason: string): CurationResult => ({
    curated: false,
    whySurfaced: null,
    whySuppressed: reason,
  });

  const surfaced = (reason: string): CurationResult => ({
    curated: true,
    whySurfaced: reason,
    whySuppressed: null,
  });

  /*
   * Terminal state first: a completed or cancelled item is history, not
   * work. It stays in the audit view forever -- that is the entire point of
   * "prefer explicit state changes over destructive behavior".
   */
  if (input.status === "completed" || input.status === "cancelled") {
    return suppressed(`Item is ${input.status}; kept for the record, not for action.`);
  }

  const deferredUntil = parse(input.deferredUntil);
  if (deferredUntil && deferredUntil > now) {
    return suppressed(`Deferred until ${shortDate(input.deferredUntil as string)}.`);
  }

  /*
   * The source withdrew its claim (e.g. the email is no longer classified
   * Needs Attention). Historical work is never silently deleted, but neither
   * should it keep occupying the curated surface -- unless Dave has since
   * taken it up himself, in which case the item is his now, not Mailroom's.
   */
  if (input.sourceWithdrawnAt && !input.confirmedByUser && input.status !== "active") {
    return suppressed(
      `Source stopped qualifying on ${shortDate(input.sourceWithdrawnAt)}; kept as history rather than deleted.`
    );
  }

  if (input.priorityTier === "background") {
    return suppressed("Chief of Staff tier: background.");
  }

  const timingAt = parse(input.timingAt);
  const plannedAt = parse(input.plannedAt);
  const expectedAt = parse(input.expectedAt);

  /*
   * Externally-owned work is not Dave's execution surface -- it is someone
   * else's, and Proxy is only holding the receipt. It earns the curated view
   * exactly when it goes overdue, which is the moment it becomes Dave's
   * problem again. (ensureOverdueExternalAttention already raises a separate
   * attention item for this; curation agrees with it rather than competing.)
   */
  if (input.responsibility === "external") {
    if (expectedAt && expectedAt <= now) {
      const who = input.waitingOnName ?? "someone";
      return surfaced(`Overdue: expected from ${who} on ${shortDate(input.expectedAt as string)}.`);
    }
    return suppressed(
      input.expectedAt
        ? `Waiting on ${input.waitingOnName ?? "someone else"} until ${shortDate(input.expectedAt)}.`
        : `Waiting on ${input.waitingOnName ?? "someone else"}; not Dave's to execute.`
    );
  }

  // --- Positive reasons, strongest first. ---

  if (input.priorityTier === "P1" || input.priorityTier === "P2") {
    return surfaced(`Chief of Staff tier ${input.priorityTier}.`);
  }

  if (timingAt) {
    const days = daysBetween(now, timingAt);
    if (days < 0) {
      return surfaced(`Overdue: ${input.timingKind === "must" ? "was due" : "targeted for"} ${shortDate(input.timingAt as string)}.`);
    }
    if (days <= DUE_HORIZON_DAYS) {
      return surfaced(`${input.timingKind === "must" ? "Due" : "Targeted for"} ${shortDate(input.timingAt as string)}.`);
    }
  }

  if (plannedAt) {
    return surfaced(`You planned this for ${shortDate(input.plannedAt as string)}.`);
  }

  if (input.confirmedByUser) {
    return surfaced("You confirmed this item.");
  }

  if (input.status === "active") {
    return surfaced("Active work.");
  }

  /*
   * Everything below here is an unconfirmed candidate with no date and no
   * directive. It gets a grace period on the strength of being new, then
   * moves to the audit view with the reason stated. Being attached to a
   * project keeps it curated: a candidate Dave has already filed under a
   * project is one he has implicitly acknowledged.
   */
  if (input.projectStateId) {
    return surfaced("Attached to a project.");
  }

  const originIso = input.sourceOccurredAt ?? input.createdAt;
  const origin = parse(originIso);
  const age = origin ? daysBetween(origin, now) : 0;

  if (age <= UNCONFIRMED_GRACE_DAYS) {
    return surfaced(
      `Recently surfaced${input.sourceSystem ? ` from ${input.sourceSystem}` : ""}${
        origin ? ` on ${shortDate(originIso)}` : ""
      }.`
    );
  }

  return suppressed(
    `Unconfirmed${input.sourceSystem ? ` ${input.sourceSystem}` : ""} candidate from ${
      origin ? shortDate(originIso) : "an unknown date"
    }: no due date, no plan, no project, and never confirmed.`
  );
}
