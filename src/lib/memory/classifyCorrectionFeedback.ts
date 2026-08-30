import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { classifyCorrectionFeedbackLocally, type CorrectionFeedbackIntent } from "./correctionFeedbackRules";

export async function classifyCorrectionFeedback(input: {
  feedback: string;
  originalStatement: string | null;
}): Promise<CorrectionFeedbackIntent> {
  const local = classifyCorrectionFeedbackLocally(input.feedback);
  if (local) return local;
  if (!process.env.ANTHROPIC_API_KEY) return "uncertain";

  try {
    const response = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages.create({
      model: "claude-sonnet-4-5-20250929", max_tokens: 80,
      system: `Classify feedback on a Memory claim. factual_correction means the feedback itself states a replacement fact. dismissal means retention feedback such as not worth remembering. outdated means the old fact is stale without a replacement fact. uncertain means ambiguous or unsure. Return exactly one token: factual_correction, dismissal, outdated, or uncertain. Never classify meta-commentary about remembering/saving as factual_correction.`,
      messages: [{ role: "user", content: `ORIGINAL: ${input.originalStatement ?? "Unknown"}\nFEEDBACK: ${input.feedback}` }],
    });
    const block = response.content.find((item) => item.type === "text");
    const intent = block?.type === "text" ? block.text.trim() : "";
    return (["factual_correction", "dismissal", "outdated", "uncertain"] as const).includes(intent as CorrectionFeedbackIntent)
      ? intent as CorrectionFeedbackIntent : "uncertain";
  } catch {
    // Fail closed: ambiguous feedback must never become a durable factual claim.
    return "uncertain";
  }
}

