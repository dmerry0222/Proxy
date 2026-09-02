/**
 * Canonical answer options for a Memory Review card.
 *
 * The buttons Dave sees are whatever the writer happened to stash in
 * `memory_review_items.payload.options`, which means a writer that forgets
 * the key produces a card with a question and no way to answer it. That is
 * exactly what artifact ingestion did: every "Review artifact context" row
 * it created had `{generated_by, source_title}` and no options, so the card
 * rendered its header and then an empty box. pending_context also has no
 * "Actually…" correction affordance to fall back on, so those items were
 * unresolvable from the UI and simply accumulated at the front of the queue.
 *
 * The fix is two-sided: writers use the constants below, and reads are
 * normalized through `reviewOptionsFor` so historical rows (and any future
 * writer that forgets again) still render a usable card.
 */

/** Matches the actions accepted by `resolve_memory_review_item`. */
export const CLAIM_REVIEW_OPTIONS = [
  "Confirm",
  "Outdated",
  "Keep as evidence",
  "Not sure",
  "Dismiss",
] as const;

/** Matches the actions accepted by `resolve_memory_pending_review_item`. */
export const PENDING_CONTEXT_REVIEW_OPTIONS = [
  "Follow up",
  "Keep waiting",
  "Resolved",
  "Dismiss",
] as const;

function includesOption(options: readonly string[], option: string): boolean {
  return options.some((candidate) => candidate.trim().toLowerCase() === option);
}

/**
 * Resolves the options to show for a row, given whatever its payload holds.
 *
 * - `pending_context` with no usable options falls back to the full set;
 *   there is no correction path for these, so an empty list is a dead card.
 * - `confirm_claim` rows predating the Dismiss action get it appended, which
 *   restores the option without rewriting historical payloads.
 * - Anything else is passed through untouched: an unknown review_type with
 *   deliberate options is not ours to second-guess.
 */
export function reviewOptionsFor(
  reviewType: string,
  payloadOptions: readonly string[] | null | undefined,
): string[] {
  const options = (payloadOptions ?? []).filter(
    (option) => typeof option === "string" && option.trim().length > 0,
  );

  if (reviewType === "pending_context" && options.length === 0) {
    return [...PENDING_CONTEXT_REVIEW_OPTIONS];
  }

  if (reviewType === "confirm_claim") {
    if (options.length === 0) {
      return [...CLAIM_REVIEW_OPTIONS];
    }

    if (!includesOption(options, "dismiss")) {
      return [...options, "Dismiss"];
    }
  }

  return options;
}
