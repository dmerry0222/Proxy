// Intentionally a self-contained copy of claimReconciliationRules.ts's
// tokenizer (STOP_WORDS included) rather than an import: a relative
// cross-file import here can't simultaneously satisfy both TypeScript
// (which rejects explicit .ts extensions without a compiler flag this
// project doesn't set) and Node's plain ESM loader (which requires them)
// -- the exact reason this file exists apart from matchCandidates.ts in
// the first place, so it can be unit-tested directly. Keep in sync with
// claimReconciliationRules.ts's propositionTokens if that tokenizer ever
// changes.
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
  "her", "hers", "him", "his", "in", "is", "it", "its", "of", "on", "she", "that", "the", "their", "them",
  "they", "this", "to", "was", "were", "with", "working", "works", "work",
]);

function propositionTokens(statement: string): string[] {
  return [
    ...new Set(
      statement
        .toLowerCase()
        .replace(/['’]s\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
        .map((token) => (token.endsWith("ing") && token.length > 5 ? token.slice(0, -3) : token))
        .map((token) => (token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token))
    ),
  ];
}

/**
 * Phase 4.5 calibration finding: claimReconciliationRules.ts's
 * propositionSimilarity (reused through Phase 3/4) scores
 * intersection/min(|A|,|B|) -- a MIN-denominator ratio that overweights a
 * shorter title sharing most of its tokens with a longer, genuinely
 * different one. Observed live: "Draft ... onboarding checklist for
 * committee" vs "... onboarding slide deck for new-hire orientation
 * session" scored 0.67 (above RANK_ATTACH_THRESHOLD) on shared "Phase N
 * diagnostic onboarding" boilerplate alone, despite different deliverables
 * and different audiences.
 *
 * This local, Execute-only scorer takes the MIN of that ratio and the true
 * (union-denominator) Jaccard index instead. Near-identical/reworded
 * titles score ~1.0 under both measures, so genuine matches (observed:
 * several 1.00 scores for actually-the-same obligation, reworded) are
 * unaffected. Titles that share a common phrase but diverge substantially
 * elsewhere now get pulled down by the union-based measure, which the
 * min-only version couldn't see. Deliberately NOT a change to
 * claimReconciliationRules.ts itself -- that scorer has its own
 * separately-tuned thresholds for Memory claim merging (0.42-0.82) and
 * this fix is specific to the different problem Execute matching has.
 *
 * Pure/I-O free (only reuses propositionTokens, the tokenizer) so it can
 * be unit-tested directly, unlike most of this module tree which sits
 * behind `import "server-only"`.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = new Set(propositionTokens(a));
  const tokensB = new Set(propositionTokens(b));
  if (!tokensA.size || !tokensB.size) return 0;
  const intersectionSize = [...tokensA].filter((token) => tokensB.has(token)).length;
  const minRatio = intersectionSize / Math.min(tokensA.size, tokensB.size);
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  const trueJaccard = intersectionSize / unionSize;
  return Math.min(minRatio, trueJaccard);
}
