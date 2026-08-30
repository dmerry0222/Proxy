/**
 * Ownership arbitration for Notion properties that Proxy proposes but a
 * human may override in place. Pure, zero-import leaf module so the rule is
 * unit testable without Notion or Supabase.
 *
 * THE RACE THIS EXISTS TO CLOSE
 *
 * Bucket and Requested Action are written by Proxy on every sync, but they
 * are also the two fields Dave edits during review. Between the moment he
 * changes one in Notion and the moment he presses Submit, a scheduled sweep
 * can overwrite his edit with Proxy's canonical value -- silently, with no
 * error, and with the sweep running every 10 minutes that window is wide
 * enough to hit in ordinary use.
 *
 * The fix is three-state ownership rather than a simple Proxy-owned /
 * human-owned split:
 *
 *   1. PROPOSED  - Notion matches what Proxy last pushed. Proxy owns it and
 *                  keeps writing updates (re-analysis, reclassification).
 *   2. OVERRIDDEN - Notion differs from what Proxy last pushed, so a human
 *                  changed it. Proxy stops writing that ONE property and
 *                  leaves the human's value alone. Other properties on the
 *                  same page continue to sync normally.
 *   3. RECONCILED - the human submitted, Proxy adopted the value, and the
 *                  baseline is reset, returning the property to state 1.
 *
 * The baseline is deliberately "what Proxy last WROTE", never "what is
 * currently in Notion". Re-baselining to the human's value would make the
 * next sync see agreement and overwrite the edit -- reintroducing the exact
 * race this closes, one sync later.
 */

export type ComparableValue = string | boolean | null;

export type GuardResolution = {
  /** The property payload to actually send, minus any overridden fields. */
  payload: Record<string, unknown>;
  /** Guarded properties a human has changed; omitted from the payload. */
  overridden: string[];
  /**
   * Baseline to persist after a successful push: what Proxy wrote for each
   * guarded property. Overridden properties keep their PREVIOUS baseline,
   * because Proxy did not write them this time.
   */
  nextBaseline: Record<string, ComparableValue>;
};

/**
 * `liveValues` is what Notion currently holds; `baseline` is what Proxy
 * recorded writing last time. A guarded property with no recorded baseline
 * (a page created before guarding existed) is treated as NOT overridden:
 * without evidence of a human edit, the safe default is normal Proxy
 * ownership, and the baseline self-heals on this very push.
 */
export function resolveGuardedProperties(input: {
  properties: Record<string, unknown>;
  guarded: string[];
  liveValues: Record<string, ComparableValue>;
  baseline: Record<string, ComparableValue>;
  proposedValues: Record<string, ComparableValue>;
}): GuardResolution {
  const payload: Record<string, unknown> = { ...input.properties };
  const overridden: string[] = [];
  const nextBaseline: Record<string, ComparableValue> = { ...input.baseline };

  for (const name of input.guarded) {
    const hasBaseline = Object.prototype.hasOwnProperty.call(input.baseline, name);
    const live = input.liveValues[name] ?? null;
    const wasWritten = hasBaseline ? input.baseline[name] : null;

    if (hasBaseline && live !== wasWritten) {
      // A human changed this since Proxy last wrote it -- leave it alone,
      // and keep the old baseline so it stays protected on later syncs.
      delete payload[name];
      overridden.push(name);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(input.proposedValues, name)) {
      nextBaseline[name] = input.proposedValues[name];
    }
  }

  return { payload, overridden, nextBaseline };
}

/**
 * Clears the guarded baselines so the named properties return to Proxy
 * ownership. Called after a submission has been reconciled: Proxy has now
 * adopted the human's values as canonical, so continuing to treat them as
 * an override would freeze those fields permanently.
 */
export function releaseGuardedBaseline(
  baseline: Record<string, ComparableValue>,
  guarded: string[]
): Record<string, ComparableValue> {
  const next = { ...baseline };
  for (const name of guarded) {
    delete next[name];
  }
  return next;
}
