/**
 * Validation and override/staleness logic for PriorityDirective (Post-
 * Phase-6 Part 2/10/11). Pure, zero-import leaf module -- runnable
 * directly via `node --experimental-strip-types --test`, same convention
 * as reviewTransitions.ts/ownershipRules.ts. The enum lists below are
 * redeclared rather than imported from execute/types.ts's PriorityDirective
 * (a type-only import would be safe under stripped-types, but keeping this
 * file import-free entirely matches the established convention for the
 * modules unit tests exercise directly). Keep in sync with
 * execute/types.ts's PriorityDirective if it changes.
 *
 * This is the ONE place "is this directive valid" is decided -- both the
 * CoS model-output path and the manual-override path must pass through it.
 * Nothing here inspects source material or operational truth (status,
 * responsibility, timing_at); it only judges the directive object itself.
 */

const TIERS = new Set(["P1", "P2", "P3", "background"]);
const HARDNESS = new Set(["hard", "moderate", "soft"]);
const PROTECTION = new Set(["protected", "normal", "flexible"]);
const DISPLACE = new Set(["P2", "P3", "background"]);
const ATTENTION = new Set(["high", "normal", "low"]);
const TIMING_KIND = new Set(["must", "target"]);
const SOURCE = new Set(["cos", "manual"]);

export type RawDirective = {
  tier?: unknown;
  why?: unknown;
  desiredOutcome?: unknown;
  timing?: unknown;
  hardness?: unknown;
  protection?: unknown;
  mayDisplace?: unknown;
  attentionPriority?: unknown;
  reassessAt?: unknown;
  escalationCondition?: unknown;
  source?: unknown;
  decidedAt?: unknown;
};

export type ValidatedDirective = {
  tier: "P1" | "P2" | "P3" | "background";
  why: string;
  desiredOutcome?: string;
  timing?: { kind: "must" | "target"; at: string };
  hardness: "hard" | "moderate" | "soft";
  protection: "protected" | "normal" | "flexible";
  mayDisplace: Array<"P2" | "P3" | "background">;
  attentionPriority?: "high" | "normal" | "low";
  reassessAt?: string;
  escalationCondition?: string;
  source: "cos" | "manual";
  decidedAt: string;
};

export type ValidationResult = { ok: true; directive: ValidatedDirective } | { ok: false; reason: string };

/**
 * The one required "ground truth" constraint: a directive's timing, if
 * present, must exactly match the item's own canonical timing (Part 8/10 --
 * "CoS cannot alter source-derived timing truth"). Pass null for a
 * project-level directive, which has no timing of its own.
 */
export function validatePriorityDirective(
  raw: RawDirective,
  groundTruth: { timingAt: string | null; timingKind: "must" | "target" | null } | null
): ValidationResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "Directive must be an object" };
  if (typeof raw.tier !== "string" || !TIERS.has(raw.tier)) return { ok: false, reason: `Invalid tier: ${String(raw.tier)}` };
  if (typeof raw.why !== "string" || !raw.why.trim()) return { ok: false, reason: "why is required" };
  if (typeof raw.hardness !== "string" || !HARDNESS.has(raw.hardness)) return { ok: false, reason: `Invalid hardness: ${String(raw.hardness)}` };
  if (typeof raw.protection !== "string" || !PROTECTION.has(raw.protection)) return { ok: false, reason: `Invalid protection: ${String(raw.protection)}` };
  if (!Array.isArray(raw.mayDisplace) || raw.mayDisplace.some((value) => !DISPLACE.has(value as string))) {
    return { ok: false, reason: "Invalid mayDisplace" };
  }
  if (typeof raw.source !== "string" || !SOURCE.has(raw.source)) return { ok: false, reason: `Invalid source: ${String(raw.source)}` };
  if (typeof raw.decidedAt !== "string" || Number.isNaN(Date.parse(raw.decidedAt))) return { ok: false, reason: "decidedAt must be a valid timestamp" };

  if (raw.attentionPriority !== undefined && (typeof raw.attentionPriority !== "string" || !ATTENTION.has(raw.attentionPriority))) {
    return { ok: false, reason: `Invalid attentionPriority: ${String(raw.attentionPriority)}` };
  }
  if (raw.reassessAt !== undefined && (typeof raw.reassessAt !== "string" || Number.isNaN(Date.parse(raw.reassessAt)))) {
    return { ok: false, reason: "reassessAt must be a valid timestamp" };
  }
  if (raw.desiredOutcome !== undefined && typeof raw.desiredOutcome !== "string") {
    return { ok: false, reason: "desiredOutcome must be a string" };
  }
  if (raw.escalationCondition !== undefined && typeof raw.escalationCondition !== "string") {
    return { ok: false, reason: "escalationCondition must be a string" };
  }

  let timing: ValidatedDirective["timing"];
  if (raw.timing !== undefined && raw.timing !== null) {
    const candidate = raw.timing as { kind?: unknown; at?: unknown };
    if (typeof candidate.kind !== "string" || !TIMING_KIND.has(candidate.kind)) return { ok: false, reason: "Invalid timing.kind" };
    if (typeof candidate.at !== "string" || Number.isNaN(Date.parse(candidate.at))) return { ok: false, reason: "Invalid timing.at" };
    // Ground-truth check: the directive may only ever restate the item's
    // own canonical timing, never invent or override it (Part 3/10).
    if (groundTruth) {
      if (!groundTruth.timingAt || !groundTruth.timingKind) {
        return { ok: false, reason: "Directive proposes timing but the item has none" };
      }
      if (candidate.kind !== groundTruth.timingKind || new Date(candidate.at).toISOString() !== new Date(groundTruth.timingAt).toISOString()) {
        return { ok: false, reason: "Directive timing does not match the item's canonical timing" };
      }
    }
    timing = { kind: candidate.kind as "must" | "target", at: candidate.at };
  }

  return {
    ok: true,
    directive: {
      tier: raw.tier as ValidatedDirective["tier"],
      why: raw.why.trim().slice(0, 500),
      desiredOutcome: typeof raw.desiredOutcome === "string" && raw.desiredOutcome.trim() ? raw.desiredOutcome.trim().slice(0, 500) : undefined,
      timing,
      hardness: raw.hardness as ValidatedDirective["hardness"],
      protection: raw.protection as ValidatedDirective["protection"],
      mayDisplace: [...new Set(raw.mayDisplace as ValidatedDirective["mayDisplace"])],
      attentionPriority: raw.attentionPriority as ValidatedDirective["attentionPriority"],
      reassessAt: raw.reassessAt as string | undefined,
      escalationCondition: typeof raw.escalationCondition === "string" && raw.escalationCondition.trim() ? raw.escalationCondition.trim().slice(0, 300) : undefined,
      source: raw.source as ValidatedDirective["source"],
      decidedAt: raw.decidedAt,
    },
  };
}

/** A manual override blocks the next automatic CoS write until it expires (Part 11) -- unless the override itself set a reassessAt in the past, which is how "force reassessment" is expressed. */
export function isManualOverrideActive(directive: ValidatedDirective | null, now: Date = new Date()): boolean {
  if (!directive || directive.source !== "manual") return false;
  if (!directive.reassessAt) return true;
  return new Date(directive.reassessAt).getTime() > now.getTime();
}

/** A CoS-authored directive past its own reassessAt is stale and eligible for reassessment (Part 6/15). */
export function isDirectiveStale(directive: ValidatedDirective | null, now: Date = new Date()): boolean {
  if (!directive) return true;
  if (!directive.reassessAt) return false;
  return new Date(directive.reassessAt).getTime() <= now.getTime();
}
