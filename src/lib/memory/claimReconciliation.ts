import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { supabaseServer } from "@/lib/supabase/server";
import { classifyClaimRelationshipDeterministically,
  type ClaimRelationship, type ExistingClaimForReconciliation } from "./claimReconciliationRules";
import { assessClaimReviewTier } from "./claimReviewPolicy";
import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";

const RELATIONSHIP_HUMAN_SUMMARY: Record<ClaimRelationship, string> = {
  new: "Proxy created a new Memory claim.",
  supports_existing: "Proxy added this as evidence for something it already knew.",
  refines_existing: "Proxy expanded on an existing Memory claim.",
  contradicts_existing: "Proxy noticed this conflicts with an existing Memory claim.",
  duplicates_existing: "Proxy recognized this as a duplicate of something it already knew.",
  supersedes_existing: "Proxy determined the existing Memory claim is now out of date.",
};

async function classifyWithModel(statement: string, existingClaims: ExistingClaimForReconciliation[]) {
  if (!process.env.ANTHROPIC_API_KEY || existingClaims.length === 0) {
    return { relationship: "new" as ClaimRelationship, existingClaimId: null as string | null, material: true };
  }
  const response = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages.create({
    model: "claude-sonnet-4-5-20250929", max_tokens: 500,
    system: `Reconcile one proposed Memory claim against existing claims about the same entity.
Prefer one proposition with many evidence links. Wording changes, temporary meeting context, examples, tools used, and minor extra detail normally support an existing core claim. User-confirmed durable claims are authoritative.
Use contradicts_existing for incompatible facts, supersedes_existing for credible real-world change over time, and refines_existing only for independently useful durable expansion. Return JSON only: {"relationship":"new|supports_existing|refines_existing|contradicts_existing|duplicates_existing|supersedes_existing","existingClaimId":"uuid or null","material":true|false}.`,
    messages: [{ role: "user", content: `PROPOSED:\n${statement}\n\nEXISTING:\n${existingClaims.map((claim) =>
      `${claim.id} | status=${claim.status} | confirmed=${claim.confirmed_by_user} | ${claim.statement}`).join("\n")}` }],
  });
  const text = response.content.find((block) => block.type === "text");
  if (text?.type !== "text") return { relationship: "new" as ClaimRelationship, existingClaimId: null, material: true };
  const raw = text.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
  let parsed: { relationship?: ClaimRelationship; existingClaimId?: string | null; material?: boolean } = {};
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { relationship: "new" as ClaimRelationship, existingClaimId: null, material: true };
  }
  const allowed: ClaimRelationship[] = ["new", "supports_existing", "refines_existing", "contradicts_existing", "duplicates_existing", "supersedes_existing"];
  return { relationship: allowed.includes(parsed.relationship as ClaimRelationship) ? parsed.relationship! : "new",
    existingClaimId: existingClaims.some((claim) => claim.id === parsed.existingClaimId) ? parsed.existingClaimId! : null,
    material: parsed.material === true };
}

function strengthRank(value: string | null) {
  return ({ weak: 1, moderate: 2, strong: 3, confirmed: 4 } as Record<string, number>)[value ?? ""] ?? 0;
}

async function loadActiveClaimsForEntity(entityId: string): Promise<ExistingClaimForReconciliation[]> {
  const { data: links, error: linksError } = await supabaseServer.from("memory_claim_entities")
    .select("claim_id").eq("entity_id", entityId);
  if (linksError) throw new Error(`Could not load entity claims for reconciliation: ${linksError.message}`);
  const claimIds = [...new Set((links ?? []).map((link) => link.claim_id))];
  if (!claimIds.length) return [];
  const { data: rows, error: claimsError } = await supabaseServer.from("memory_claims")
    .select("id, statement, status, confirmed_by_user, evidence_strength, claim_type, is_governing_context")
    .in("id", claimIds).in("status", ["candidate", "durable", "evidence_only"]);
  if (claimsError) throw new Error(`Could not load active claims for reconciliation: ${claimsError.message}`);
  return (rows ?? []) as ExistingClaimForReconciliation[];
}

/**
 * Deterministic "have we already got this?" pre-check for the claim-creation
 * paths that do NOT run full reconciliation -- Calendar reconciliation and
 * Teams conversation processing. Both used to insert a claim plus a
 * `confirm_claim` review item unconditionally, which is how the same
 * real-world fact reached Dave's queue several times over from different
 * sources.
 *
 * Deliberately narrower than the email path's reconciliation: ONLY
 * `duplicates_existing` collapses here. Three outcomes are excluded on
 * purpose:
 *
 *   - `supersedes_existing` / `contradicts_existing`: a later state-change
 *     or a conflicting value must never be silently folded backwards into
 *     the older claim.
 *   - `supports_existing`: this fires at a similarity of 0.65, which a
 *     read-only audit of the real backlog showed is loose enough to absorb
 *     genuinely DIFFERENT propositions that merely share vocabulary --
 *     e.g. "responsible for distributing meeting minutes" scored as
 *     supporting "is working on the Grad Program Health Rubric." Skipping
 *     claim creation on that basis would lose a real fact, so these fall
 *     through and become their own claim.
 *
 * That leaves the 0.82 near-identical bar plus the monetary value guard --
 * a deliberately high bar for discarding a proposition.
 */
export async function findCollapsibleExistingClaim(entityId: string, statement: string): Promise<
  { claim: ExistingClaimForReconciliation; relationship: "duplicates_existing" } | null
> {
  const existingClaims = await loadActiveClaimsForEntity(entityId);
  for (const existing of existingClaims.sort((a, b) => Number(b.confirmed_by_user) - Number(a.confirmed_by_user))) {
    if (classifyClaimRelationshipDeterministically(statement, existing) === "duplicates_existing") {
      return { claim: existing, relationship: "duplicates_existing" };
    }
  }
  return null;
}

export async function reconcileMemoryClaim(input: {
  entityId: string; sourceId: string; statement: string; claimType: string;
  evidenceContent: string; evidenceStrength: string; effectiveFrom?: string | null;
  evidenceMetadata?: Record<string, unknown>; claimMetadata?: Record<string, unknown>;
  reviewTitle: string; reviewPriority: number; reviewPayload: Record<string, unknown>;
  locator?: Record<string, unknown>;
  traceId?: string | null; parentEventId?: string | null;
}) {
  const existingClaims = await loadActiveClaimsForEntity(input.entityId);

  let selected: ExistingClaimForReconciliation | null = null;
  let relationship: ClaimRelationship | null = null;
  let classifiedBy: "rule" | "model" = "rule";
  for (const existing of existingClaims.sort((a, b) => Number(b.confirmed_by_user) - Number(a.confirmed_by_user))) {
    const outcome = classifyClaimRelationshipDeterministically(input.statement, existing);
    if (outcome) { selected = existing; relationship = outcome; break; }
  }
  let material = true;
  if (!relationship) {
    classifiedBy = "model";
    const model = await classifyWithModel(input.statement, existingClaims.slice(0, 25));
    relationship = model.relationship;
    selected = existingClaims.find((claim) => claim.id === model.existingClaimId) ?? null;
    material = model.material;
  }
  if (!selected && relationship !== "new") relationship = "new";
  if (relationship === "refines_existing" && !material) relationship = "supports_existing";

  const decisionReason = selected
    ? `${classifiedBy === "rule" ? "Wording overlap against" : "Model comparison against"} existing claim${
        selected.confirmed_by_user ? " (previously confirmed by Dave)" : ""
      }: "${selected.statement}"`
    : "No sufficiently similar existing claim was found for this entity.";

  let evidence: { id: string } | null = null;
  const { data: existingEvidence, error: existingEvidenceError } = await supabaseServer.from("memory_evidence")
    .select("id").eq("source_id", input.sourceId).eq("content", input.evidenceContent).limit(1).maybeSingle();
  if (existingEvidenceError) throw new Error(`Could not check existing evidence: ${existingEvidenceError.message}`);
  evidence = existingEvidence;
  if (!evidence) {
    const { data, error } = await supabaseServer.from("memory_evidence").insert({ source_id: input.sourceId,
      evidence_type: "excerpt", content: input.evidenceContent, effective_from: input.effectiveFrom ?? null,
      visibility: "normal", extracted_by: "ai", locator: input.locator ?? {}, metadata: input.evidenceMetadata ?? {} })
      .select("id").single();
    if (error || !data) throw new Error(`Could not create reconciled evidence: ${error?.message ?? "Unknown error"}`);
    evidence = data;
    const { error: entityError } = await supabaseServer.from("memory_evidence_entities").upsert({
      evidence_id: evidence.id, entity_id: input.entityId, relationship: "subject",
    }, { onConflict: "evidence_id,entity_id,relationship", ignoreDuplicates: true });
    if (entityError) throw new Error(`Could not connect reconciled evidence: ${entityError.message}`);
  }

  if (selected && ["supports_existing", "duplicates_existing"].includes(relationship)) {
    const { error } = await supabaseServer.from("memory_claim_evidence").upsert({ claim_id: selected.id,
      evidence_id: evidence.id, relationship: "supports" }, { onConflict: "claim_id,evidence_id", ignoreDuplicates: true });
    if (error) throw new Error(`Could not attach supporting evidence: ${error.message}`);
    if (!selected.confirmed_by_user && strengthRank(input.evidenceStrength) > strengthRank(selected.evidence_strength)) {
      await supabaseServer.from("memory_claims").update({ evidence_strength: input.evidenceStrength,
        updated_at: new Date().toISOString() }).eq("id", selected.id);
    }
    await emitDiagnosticEvent({
      traceId: input.traceId ?? null, parentEventId: input.parentEventId ?? null,
      module: "memory", stage: "reconciled", eventType: "claim_reconciliation", status: "success",
      objectType: "memory_claim", objectId: selected.id,
      humanSummary: RELATIONSHIP_HUMAN_SUMMARY[relationship],
      humanDetail: `New observation: "${input.statement}"`,
      decisionType: relationship, decisionReason: decisionReason,
      metadata: { classified_by: classifiedBy, existing_claim_id: selected.id },
    });
    return { outcome: relationship, claimId: selected.id, claimCreated: false, reviewCreated: false,
      evidenceCreated: !existingEvidence };
  }

  if (selected && relationship === "contradicts_existing") {
    const { error } = await supabaseServer.from("memory_claim_evidence").upsert({ claim_id: selected.id,
      evidence_id: evidence.id, relationship: "contradicts" }, { onConflict: "claim_id,evidence_id" });
    if (error) throw new Error(`Could not attach contradictory evidence: ${error.message}`);
  }

  // relationship is narrowed to non-"supports_existing"/"duplicates_existing" here (those returned above).
  const reviewRelationship = relationship as "new" | "refines_existing" | "contradicts_existing" | "supersedes_existing";
  const tierResult = assessClaimReviewTier({
    claimType: input.claimType, statement: input.statement,
    evidenceStrength: (input.evidenceStrength as "weak" | "moderate" | "strong" | "confirmed") ?? null,
    relationship: reviewRelationship,
    existingClaim: selected
      ? { claimType: selected.claim_type, confirmedByUser: selected.confirmed_by_user, isGoverningContext: selected.is_governing_context }
      : null,
  });
  const autoSave = tierResult.tier === "auto_save";

  const { data: candidate, error: candidateError } = await supabaseServer.from("memory_claims").insert({
    claim_type: input.claimType, statement: input.statement, status: "candidate",
    learned_at: new Date().toISOString(), evidence_strength: input.evidenceStrength,
    promotion_basis: "ai_extraction", confirmed_by_user: false, visibility: "normal", created_by: "ai",
    metadata: { ...(input.claimMetadata ?? {}), reconciliation_outcome: relationship,
      reconciles_claim_id: selected?.id ?? null, risk_tier: tierResult.tier, risk_tier_reason: tierResult.reason },
  }).select("id").single();
  if (candidateError || !candidate) throw new Error(`Could not create reconciled candidate: ${candidateError?.message ?? "Unknown error"}`);

  const linkResults = await Promise.all([
    supabaseServer.from("memory_claim_entities").insert({ claim_id: candidate.id, entity_id: input.entityId, role: "subject" }),
    supabaseServer.from("memory_claim_evidence").insert({ claim_id: candidate.id, evidence_id: evidence.id, relationship: "supports" }),
    ...(autoSave ? [] : [supabaseServer.from("memory_review_items").insert({ review_type: "confirm_claim", status: "pending",
      title: input.reviewTitle, prompt: input.statement, claim_id: candidate.id, entity_id: input.entityId,
      priority: input.reviewPriority, payload: { ...input.reviewPayload, reconciliation_outcome: relationship,
        existing_claim_id: selected?.id ?? null } })]),
  ]);
  const linkError = linkResults.find((result) => result.error)?.error;
  if (linkError) throw new Error(`Could not finish reconciled claim: ${linkError.message}`);

  if (autoSave && selected && (relationship === "contradicts_existing" || relationship === "supersedes_existing")) {
    /*
     * Low-stakes contradiction/supersession: don't ask Dave to referee it.
     * Supersede the older observation automatically -- lowering its
     * effective confidence by retiring it in favor of the newer one.
     */
    const { error: supersedeError } = await supabaseServer.from("memory_claims").update({
      status: "superseded", superseded_by_claim_id: candidate.id, updated_at: new Date().toISOString(),
    }).eq("id", selected.id);
    if (supersedeError) throw new Error(`Could not auto-supersede prior claim: ${supersedeError.message}`);
  }

  await emitDiagnosticEvent({
    traceId: input.traceId ?? null, parentEventId: input.parentEventId ?? null,
    module: "memory", stage: "reconciled", eventType: "claim_reconciliation", status: "success",
    objectType: "memory_claim", objectId: candidate.id,
    humanSummary: autoSave
      ? `${RELATIONSHIP_HUMAN_SUMMARY[relationship]} Auto-saved (low risk) -- no review needed.`
      : RELATIONSHIP_HUMAN_SUMMARY[relationship],
    humanDetail: `New observation: "${input.statement}"`,
    decisionType: relationship, decisionReason: decisionReason,
    metadata: { classified_by: classifiedBy, existing_claim_id: selected?.id ?? null, review_created: !autoSave,
      auto_saved: autoSave, risk_tier: tierResult.tier, risk_tier_reason: tierResult.reason },
  });
  return { outcome: relationship, claimId: candidate.id, claimCreated: true, reviewCreated: !autoSave,
    evidenceCreated: !existingEvidence };
}
