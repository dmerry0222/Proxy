export type ClaimRelationship = "new" | "supports_existing" | "refines_existing" |
  "contradicts_existing" | "duplicates_existing" | "supersedes_existing";

export type ExistingClaimForReconciliation = {
  id: string; statement: string; status: string; confirmed_by_user: boolean; evidence_strength: string | null;
};

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he",
  "her", "hers", "him", "his", "in", "is", "it", "its", "of", "on", "she", "that", "the", "their", "them",
  "they", "this", "to", "was", "were", "with", "working", "works", "work", "oleary", "o'leary"]);
const CHANGE_CUES = /\b(no longer|not anymore|stopped|ceased|left|departed|replaced|now leads|now owns|transferred|changed)\b/i;
const NEGATION = /\b(no|not|never|isn't|aren't|doesn't|didn't|no longer)\b/i;

export function propositionTokens(statement: string) {
  return [...new Set(statement.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .map((token) => token.endsWith("ing") && token.length > 5 ? token.slice(0, -3) : token)
    .map((token) => token.endsWith("s") && token.length > 4 ? token.slice(0, -1) : token))];
}

export function propositionSimilarity(left: string, right: string) {
  const a = new Set(propositionTokens(left)); const b = new Set(propositionTokens(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / Math.min(a.size, b.size);
}

export function classifyClaimRelationshipDeterministically(candidate: string,
  existing: ExistingClaimForReconciliation): ClaimRelationship | null {
  const normalizedCandidate = candidate.toLowerCase().replace(/\W+/g, " ").trim();
  const normalizedExisting = existing.statement.toLowerCase().replace(/\W+/g, " ").trim();
  if (normalizedCandidate === normalizedExisting) return "duplicates_existing";
  const similarity = propositionSimilarity(candidate, existing.statement);
  if (similarity >= 0.45 && CHANGE_CUES.test(candidate)) return "supersedes_existing";
  if (similarity >= 0.55 && NEGATION.test(candidate) !== NEGATION.test(existing.statement)) return "contradicts_existing";
  if (existing.confirmed_by_user && ["durable", "candidate"].includes(existing.status) && similarity >= 0.42) return "supports_existing";
  if (similarity >= 0.82) return "duplicates_existing";
  if (similarity >= 0.65) return propositionTokens(candidate).length > propositionTokens(existing.statement).length + 3
    ? "refines_existing" : "supports_existing";
  return null;
}

