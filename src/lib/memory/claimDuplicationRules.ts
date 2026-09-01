/**
 * Pure, zero-import value-conflict guard for claim duplicate detection.
 *
 * WHY THIS EXISTS: `propositionSimilarity` tokenizes by stripping every
 * non-alphanumeric character and dropping tokens of length <= 2, which
 * makes monetary amounts effectively INVISIBLE to it:
 *
 *   "budget is $3,000"  -> [budget, 000]
 *   "budget is $4,000"  -> [budget, 000]   similarity = 1.0
 *
 * So the existing `similarity >= 0.82 -> duplicates_existing` rule would
 * happily collapse a $3,000 claim into a $4,000 claim -- silently
 * destroying the only part of the statement that actually mattered. This
 * module supplies the missing check: two statements that assert DIFFERENT
 * salient values are never the same proposition, no matter how similar
 * their wording.
 *
 * Deliberately limited to money and percentages. Dates were considered and
 * excluded: a restated fact legitimately carries a new "as of" date
 * ("... as of August 31" vs "... as of September 1") without being a
 * different proposition, so treating date differences as conflicts would
 * block correct duplicate collapsing far more often than it would help.
 */

/** Normalized monetary amounts, e.g. "$3,000.00" and "$3000" both -> 3000. */
export function extractMonetaryAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const match of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    const value = Number.parseFloat(match[1].replace(/,/g, ""));
    if (Number.isFinite(value)) amounts.push(value);
  }
  return amounts;
}

/** Percentages, e.g. "15%" and "15 percent" both -> 15. */
export function extractPercentages(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi)) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/**
 * True when both statements assert salient values AND neither value set is
 * a subset of the other.
 *
 * The subset rule is what makes the real Career Ambassador cluster behave
 * correctly. "Reduced the CA budget to $3,000 from $4,000" carries
 * {3000, 4000}; "The CA budget for this year is $3,000" carries {3000}.
 * {3000} is a subset, so these two ARE allowed to be recognized as the
 * same proposition (the second is the same decision stated more briefly).
 * But {3000} vs {4000} is disjoint -- a genuine value conflict, never a
 * duplicate.
 */
export function valuesConflict(left: string, right: string): boolean {
  const compare = (a: number[], b: number[]) => {
    if (a.length === 0 || b.length === 0) return false;
    const setA = new Set(a);
    const setB = new Set(b);
    const aInB = [...setA].every((value) => setB.has(value));
    const bInA = [...setB].every((value) => setA.has(value));
    return !aInB && !bInA;
  };

  return (
    compare(extractMonetaryAmounts(left), extractMonetaryAmounts(right)) ||
    compare(extractPercentages(left), extractPercentages(right))
  );
}
