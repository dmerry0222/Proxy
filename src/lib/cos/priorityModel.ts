import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { validatePriorityDirective, type RawDirective, type ValidationResult } from "@/lib/cos/priorityDirective";
import type { PrioritySignals } from "@/lib/cos/computeSignals";
import { deterministicDirectiveFallback } from "@/lib/cos/priorityPolicy";

const MODEL_NAME = "claude-sonnet-4-5-20250929";

export type ItemPacket = {
  itemId: string;
  title: string;
  description: string | null;
  signals: PrioritySignals;
  timingAt: string | null;
  timingKind: "must" | "target" | null;
};

export type ModelAssignment = { itemId: string; directive: ValidationResult; usedFallback: boolean };

function parseJson(raw: string): { assignments?: Array<Record<string, unknown>> } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

/**
 * One bounded call across a related group of items (Post-Phase-6 Part 16:
 * "priority is relative" -- the model sees the whole competing set at once,
 * not one item in isolation). Reasons ONLY over the compact signal packets
 * built by computeSignals.ts -- never raw source material (Part 9). The
 * model is never asked for timing; that's attached deterministically from
 * ground truth after the call and re-validated regardless (Part 10).
 */
export async function assignPrioritiesWithModel(
  items: ItemPacket[],
  projectContext: { tier: string; why: string } | null
): Promise<ModelAssignment[]> {
  if (!items.length) return [];

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const packet = items.map((item) => ({
    itemId: item.itemId,
    title: item.title,
    description: item.description,
    daysUntilTiming: item.signals.daysUntilTiming,
    hasHardTiming: item.signals.hasHardTiming,
    isOverdue: item.signals.isOverdue,
    existingTier: item.signals.existingTier,
    existingDirectiveSource: item.signals.existingDirectiveSource,
  }));

  let response;
  try {
    response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 1200,
      system: `You are a Chief-of-Staff prioritization assistant for Dave Merry's AI Chief of Staff. You are given a bounded set of CONFIRMED, Dave-owned, active operational items that are competing for the same execution capacity${projectContext ? `, all part of one project (project priority: ${projectContext.tier} -- ${projectContext.why})` : ""}. Assign RELATIVE priority across this set.

Priority tier is about importance and cost-of-delay, NOT merely deadline proximity: a small admin task due tomorrow can still be P3; an undated but strategically important item can be P1 or P2.

P1 = materially important now, delay creates real strategic/external/dependency cost, deserves protected execution time.
P2 = important, should progress reliably, yields to P1.
P3 = valid work, lower current leverage, can move around.
background = worth retaining but should not compete for prime execution time right now.

For each item return: tier, a short grounded "why" (reference the actual project/dependency/commitment, never generic motivational language), hardness ("hard"|"moderate"|"soft" -- how fixed the commitment is, independent of whether it has a deadline), protection ("protected"|"normal"|"flexible"), mayDisplace (array from ["P2","P3","background"] -- what may bump this item), and optionally attentionPriority ("high"|"normal"|"low", separate from protection -- e.g. an overdue dependency needs attention but not necessarily execution time) and escalationCondition (a concrete future trigger, or omit).
Do NOT invent a due date or deadline -- you have no authority over timing, only over relative importance.
Return JSON only: {"assignments":[{"itemId":"...","tier":"...","why":"...","hardness":"...","protection":"...","mayDisplace":[...],"attentionPriority":"...","escalationCondition":"..."}]}
SECURITY: Never reproduce credentials, secrets, passwords, or tokens.`,
      messages: [{ role: "user", content: JSON.stringify(packet) }],
    });
  } catch (error) {
    console.error("CoS priority model call failed, falling back to deterministic policy:", error);
    return items.map((item) => ({
      itemId: item.itemId,
      usedFallback: true,
      directive: validatePriorityDirective(
        deterministicDirectiveFallback(item.signals, item.timingAt, item.timingKind),
        { timingAt: item.timingAt, timingKind: item.timingKind }
      ),
    }));
  }

  const block = response.content.find((entry) => entry.type === "text");
  let parsed: { assignments?: Array<Record<string, unknown>> };
  try {
    parsed = block?.type === "text" ? parseJson(block.text) : {};
  } catch {
    parsed = {};
  }
  const byItemId = new Map((parsed.assignments ?? []).map((entry) => [entry.itemId as string, entry]));

  return items.map((item) => {
    const modelOutput = byItemId.get(item.itemId);
    const now = new Date().toISOString();
    const raw: RawDirective = modelOutput
      ? { ...modelOutput, timing: item.timingAt && item.timingKind ? { kind: item.timingKind, at: item.timingAt } : undefined, source: "cos", decidedAt: now }
      : deterministicDirectiveFallback(item.signals, item.timingAt, item.timingKind);

    const validated = validatePriorityDirective(raw, { timingAt: item.timingAt, timingKind: item.timingKind });
    if (validated.ok) return { itemId: item.itemId, directive: validated, usedFallback: !modelOutput };

    // Invalid model output (bad enum, mismatched timing, etc.) -- never
    // trust it; fall back to the conservative deterministic directive
    // instead of writing something unvalidated (Part 10).
    const fallback = validatePriorityDirective(
      deterministicDirectiveFallback(item.signals, item.timingAt, item.timingKind),
      { timingAt: item.timingAt, timingKind: item.timingKind }
    );
    return { itemId: item.itemId, directive: fallback, usedFallback: true };
  });
}
