export type CorrectionFeedbackIntent = "factual_correction" | "dismissal" | "outdated" | "uncertain";

const DISMISSAL_PATTERNS = [
  /\b(?:do not|don't|dont|no need to)\s+(?:remember|save|keep|store)\b/i,
  /\b(?:unnecessary|not worth|isn't useful|is not useful|irrelevant)\b.*\b(?:remember|save|saving|keep|memory|this)\b/i,
  /\b(?:dismiss|discard|forget|remove)\s+(?:this|it|claim|memory)?\b/i,
];
const OUTDATED_PATTERN = /\b(?:outdated|no longer true|used to be|not true anymore|stale)\b/i;
const UNCERTAIN_PATTERN = /\b(?:not sure|uncertain|maybe|i don't know|i do not know)\b/i;

export function classifyCorrectionFeedbackLocally(text: string): CorrectionFeedbackIntent | null {
  const value = text.trim();
  if (!value) return "uncertain";
  if (DISMISSAL_PATTERNS.some((pattern) => pattern.test(value))) return "dismissal";
  if (OUTDATED_PATTERN.test(value)) return "outdated";
  if (UNCERTAIN_PATTERN.test(value)) return "uncertain";
  return null;
}

