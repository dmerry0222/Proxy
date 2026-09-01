/**
 * Pure queue-advancement rule for the Memory Review card stack.
 *
 * Extracted from MemoryReview.tsx so the behaviour that actually broke is
 * testable without a DOM: the component previously copied the server list
 * into `useState`, which meant (a) later server renders were ignored, so a
 * stale queue could never self-correct, and (b) the only way an item left
 * the stack was an optimistic `slice(1)`.
 *
 * The rule here is deliberately one-directional: the server supplies what
 * is pending, the session supplies what it has already resolved, and an
 * item is shown only if the server still lists it AND this session has not
 * resolved it. Because the resolved set outlives any individual fetch, a
 * refresh that races the write (or a cached/stale response) cannot bring a
 * cleared card back.
 */

export type ReviewQueueItem = { id: string };

export function selectActiveReviewQueue<T extends ReviewQueueItem>(
  serverItems: readonly T[],
  resolvedIds: ReadonlySet<string>,
): T[] {
  return serverItems.filter((item) => !resolvedIds.has(item.id));
}

/** The card currently in front of Dave, or null when the queue is empty. */
export function activeReviewCard<T extends ReviewQueueItem>(
  serverItems: readonly T[],
  resolvedIds: ReadonlySet<string>,
): T | null {
  return selectActiveReviewQueue(serverItems, resolvedIds)[0] ?? null;
}

/** Returns a new set -- never mutates the caller's, so React sees a change. */
export function withResolved(
  resolvedIds: ReadonlySet<string>,
  resolvedId: string,
): ReadonlySet<string> {
  const next = new Set(resolvedIds);
  next.add(resolvedId);
  return next;
}
