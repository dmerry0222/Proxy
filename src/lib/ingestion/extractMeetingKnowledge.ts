import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { reconcileMemoryClaim } from "@/lib/memory/claimReconciliation";
import { supabaseServer } from "@/lib/supabase/server";
import { gatesDaveOwnership } from "@/lib/reconciliation/ownershipRules";
import { recordExecutionEvidence } from "@/lib/reconciliation/evidence";
import { completeReconciliationRun, emptyCounters, recordReconciliationDecision, startReconciliationRun } from "@/lib/reconciliation/runs";
import type { OwnershipBasis, OwnershipEvidence } from "@/lib/reconciliation/types";
import type { ParsedSection } from "@/lib/ingestion/types";

const EXTRACTION_VERSION = 1;
const MODEL_NAME = "claude-sonnet-4-5-20250929";
const CLAIM_TYPES = new Set(["fact", "role", "responsibility", "relationship",
  "project_association", "decision", "status", "milestone", "preference",
  "governing_context", "working_context", "other"]);

type ExtractedTask = {
  title?: string;
  description?: string | null;
  assigneeEmail?: string | null;
  dueAt?: string | null;
  priority?: string;
  evidence?: string;
  sectionOrdinal?: number;
  confidence?: number;
  extractionBasis?: string;
  owner?: string;
  ownershipBasis?: string;
  ownershipEvidence?: string;
};

type ExtractedClaim = {
  statement?: string;
  claimType?: string;
  subjectEmail?: string;
  evidence?: string;
  sectionOrdinal?: number;
  evidenceStrength?: string;
};

function parseJson(raw: string): { tasks?: ExtractedTask[]; claims?: ExtractedClaim[] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

export async function extractMeetingKnowledge({
  meetingId,
  artifactId,
  sourceId,
  title,
  occurredAt,
  sections,
  participantEmails,
}: {
  meetingId: string;
  artifactId: string;
  sourceId: string;
  title: string;
  occurredAt: string | null;
  sections: ParsedSection[];
  participantEmails: string[];
}) {
  const relevant = sections
    .filter((section) => section.content.trim())
    .slice(0, 30)
    .map((section) => `[Section ${section.ordinal}: ${section.sectionType}${section.heading ? ` — ${section.heading}` : ""}]\n${section.content}`)
    .join("\n\n");

  if (!relevant) return { tasksCreated: 0, claimsCreated: 0 };

  const { runId, traceId } = await startReconciliationRun({
    trigger: "forward",
    sourceType: "meeting_artifact",
    sourceId: artifactId,
    summary: `Reconcile meeting artifact: ${title}`,
    metadata: { meetingId, artifactId, sourceId },
  });
  const counters = emptyCounters();

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 1800,
      system: `Extract actionable work and durable Memory candidates from meeting artifacts for Dave Merry's AI Chief of Staff.
TASKS: Create an execution candidate only when the action belongs to Dave, was explicitly assigned to Dave, or was explicitly accepted by Dave. Never create Dave tasks from recommendations, instructions, action-oriented prose, or responsibilities belonging to somebody else. Uncertain ownership means no task. Preserve Dave's email only when supplied. Resolve relative dates from the meeting date. A task must stand alone and include exact ownership evidence.
CLAIMS: Be conservative. Extract at most 4 durable facts about a supplied participant: roles, ongoing responsibilities, project associations, explicit decisions, meaningful status, or clearly stated preferences. Do not summarize, infer attendance, or attach claims to organizations/events as people.
SECURITY: Never reproduce passwords, tokens, keys, secrets, or credentials.
Return JSON only with {"tasks":[],"claims":[]}.
Task shape: {"title":"...","description":null,"assigneeEmail":null,"dueAt":null,"priority":"low|normal|high|urgent","evidence":"exact supporting excerpt","sectionOrdinal":0,"confidence":0.0,"owner":"dave","ownershipBasis":"explicit_assignment_to_dave|explicit_acceptance_by_dave","ownershipEvidence":"exact excerpt proving Dave owns it"}.
Claim shape: {"statement":"...","claimType":"fact|role|responsibility|relationship|project_association|decision|status|milestone|preference|governing_context|working_context|other","subjectEmail":"participant@example.com","evidence":"exact supporting excerpt","sectionOrdinal":0,"evidenceStrength":"weak|moderate|strong"}.`,
      messages: [{ role: "user", content: `Meeting: ${title}\nMeeting date: ${occurredAt ?? "Unknown"}\nKnown participant emails: ${participantEmails.join(", ") || "None supplied"}\n\n${relevant}` }],
    });
    const text = response.content.find((item) => item.type === "text");
    const extracted = text?.type === "text" ? parseJson(text.text) : { tasks: [], claims: [] };

    const { data: sectionRows, error: sectionError } = await supabaseServer.from("document_sections")
      .select("id, ordinal").eq("artifact_id", artifactId);
    if (sectionError) throw new Error(`Could not load section locators: ${sectionError.message}`);
    const sectionIds = new Map((sectionRows ?? []).map((section) => [section.ordinal, section.id]));

    // Ownership gate is applied via the shared reconciliation rule
    // (src/lib/reconciliation/ownershipRules.ts) rather than a local Set,
    // consolidating what used to be an independently-declared duplicate of
    // interpretGenericArtifact.ts's gate. Filter-then-slice order preserved
    // exactly as before this refactor.
    let tasksCreated = 0;
    const rawTasks = extracted.tasks ?? [];
    counters.evidenceConsidered += rawTasks.length;

    for (const task of rawTasks) {
      if (!task.title?.trim()) continue;

      const ownership: OwnershipEvidence =
        task.owner === "dave"
          ? { owner: "dave", basis: (task.ownershipBasis ?? "") as OwnershipBasis, excerpt: task.ownershipEvidence ?? "" }
          : { owner: "ambiguous" };

      const passesOwnershipGate = gatesDaveOwnership(ownership);
      if (!passesOwnershipGate || tasksCreated >= 10) {
        counters.itemsIgnored += 1;
        await recordReconciliationDecision(traceId, {
          runId,
          evidenceRef: { artifactId, sectionOrdinal: task.sectionOrdinal ?? null, title: task.title },
          outcome: "no_action",
          automatic: true,
          reasoningSummary: passesOwnershipGate
            ? "Discarded: 10-candidate cap already reached for this artifact."
            : `Ownership basis "${task.ownershipBasis ?? "none"}" does not clear the Dave-ownership gate; no task created.`,
        });
        continue;
      }

      const resolution = task.assigneeEmail ? await resolveMemoryEntityByEmail(task.assigneeEmail) : null;
      const confidence = Math.min(1, Math.max(0, Number(task.confidence ?? 0.5)));
      const timingAt = task.dueAt && !Number.isNaN(Date.parse(task.dueAt))
        ? new Date(task.dueAt).toISOString()
        : null;
      const { data: row, error } = await supabaseServer.from("execution_items").insert({
        title: task.title.trim(), description: task.description?.trim() || null,
        assignee_entity_id: resolution?.entityId ?? null,
        responsibility: "mine",
        timing_at: timingAt, timing_kind: timingAt ? "target" : null,
        source_meeting_id: meetingId, source_artifact_id: artifactId,
        confidence, extraction_basis: task.ownershipBasis,
        metadata: { assignee_email: task.assigneeEmail ?? null, source_priority: task.priority ?? "normal",
          ownership_evidence: task.ownershipEvidence!.trim(), extraction_version: EXTRACTION_VERSION },
      }).select("id").single();
      if (error || !row) throw new Error(`Could not create meeting task: ${error?.message ?? "Unknown error"}`);

      const sectionId = sectionIds.get(Number(task.sectionOrdinal));
      if (sectionId && task.evidence?.trim()) {
        await recordExecutionEvidence({
          executionItemId: row.id,
          sourceType: "document_section",
          sourceLocator: { section_id: sectionId },
          relationship: "supports_creation",
          excerpt: task.evidence.trim(),
          occurredAt,
        });
      }

      counters.itemsCreated += 1;
      tasksCreated += 1;
      await recordReconciliationDecision(traceId, {
        runId,
        evidenceRef: { artifactId, sectionOrdinal: task.sectionOrdinal ?? null, executionItemId: row.id },
        outcome: "create_dave_item",
        matchedExecutionItemId: row.id,
        confidence,
        ownershipBasis: task.ownershipBasis,
        modelProvider: "anthropic",
        modelName: MODEL_NAME,
        automatic: true,
        reasoningSummary: `Explicit first-person/assigned commitment by Dave (${task.ownershipBasis}): "${task.ownershipEvidence}"`,
      });
    }

    let claimsCreated = 0;
    for (const claim of (extracted.claims ?? []).filter((item) => item.statement?.trim() && item.subjectEmail).slice(0, 4)) {
      const resolution = await resolveMemoryEntityByEmail(claim.subjectEmail);
      if (!resolution) continue;
      const statement = claim.statement!.trim();
      const claimType = CLAIM_TYPES.has(claim.claimType ?? "") ? claim.claimType! : "other";
      const strength = ["weak", "moderate", "strong"].includes(claim.evidenceStrength ?? "") ? claim.evidenceStrength! : "weak";
      const sectionId = sectionIds.get(Number(claim.sectionOrdinal));
      const result = await reconcileMemoryClaim({
        entityId: resolution.entityId, sourceId, statement, claimType,
        evidenceContent: claim.evidence?.trim() || statement, evidenceStrength: strength,
        effectiveFrom: occurredAt,
        locator: { artifact_id: artifactId, section_id: sectionId ?? null, section_ordinal: claim.sectionOrdinal ?? null },
        evidenceMetadata: { extraction_type: "meeting_claim_candidate", ingestion_version: EXTRACTION_VERSION },
        claimMetadata: { source_type: "meeting_artifact", source_id: sourceId, ingestion_version: EXTRACTION_VERSION },
        reviewTitle: "Review meeting Memory", reviewPriority: 45,
        reviewPayload: { options: ["Confirm", "Outdated", "Keep as evidence", "Not sure", "Dismiss"],
          generated_by: "meeting_ingestion", ingestion_version: EXTRACTION_VERSION,
          source_title: title, source_date: occurredAt, source_type: "meeting_artifact" },
      });
      if (result.claimCreated) claimsCreated += 1;
    }

    await completeReconciliationRun(runId, traceId, {
      status: "completed",
      counters,
      summary: `Meeting artifact reconciled: ${tasksCreated} task(s), ${claimsCreated} claim(s)`,
    });

    return { tasksCreated, claimsCreated };
  } catch (error) {
    counters.errors += 1;
    await completeReconciliationRun(runId, traceId, {
      status: "failed",
      counters,
      summary: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}
