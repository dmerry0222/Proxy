import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { resolveMemoryEntityByEmail } from "@/lib/memory/resolveEntity";
import { reconcileMemoryClaim } from "@/lib/memory/claimReconciliation";
import { supabaseServer } from "@/lib/supabase/server";

const INGESTION_VERSION = 1;
const CLAIM_TYPES = new Set([
  "fact", "role", "responsibility", "relationship", "project_association",
  "decision", "status", "milestone", "preference", "governing_context",
  "working_context", "other",
]);
const EVIDENCE_STRENGTHS = new Set(["weak", "moderate", "strong"]);

type ExtractedClaim = {
  claimType?: string;
  statement?: string;
  evidenceStrength?: string;
};

type TeamsMessageRow = {
  message_id: string;
  chat_id: string | null;
  message_type: string | null;
  sender_user_id: string | null;
  sender_display_name: string | null;
  created_at: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: unknown;
  mentions: unknown;
};

function redactSensitiveContent(text: string) {
  return text
    .replace(/((?:password|passwd|passcode|pwd|pw)\s*[:=]\s*)([^\s<;]+)/gi, "$1[REDACTED]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*)([^\s<;]+)/gi, "$1[REDACTED]");
}

function parseJsonObject(text: string): { claims?: ExtractedClaim[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim()) as { claims?: ExtractedClaim[] };
}

async function resolveTeamsSender(senderUserId: string | null) {
  if (!senderUserId) return null;

  const { data, error } = await supabaseServer
    .from("org_chart")
    .select("employeeemail, employee_upn")
    .ilike("employeeid", senderUserId.trim())
    .limit(2);

  if (error) throw new Error(`Could not resolve Teams sender in org chart: ${error.message}`);
  if (!data || data.length !== 1) return null;

  return resolveMemoryEntityByEmail(data[0].employeeemail ?? data[0].employee_upn);
}

export async function ingestTeamsMessageToMemory(messageId: string) {
  const { data, error } = await supabaseServer
    .from("teams_messages")
    .select(`message_id, chat_id, message_type, sender_user_id, sender_display_name,
      created_at, body_text, body_html, attachments, mentions`)
    .eq("message_id", messageId)
    .single();

  if (error || !data) {
    throw new Error(`Could not load Teams message: ${error?.message ?? "Message not found"}`);
  }

  const message = data as TeamsMessageRow;
  const resolution = await resolveTeamsSender(message.sender_user_id);
  if (!resolution) return { ingested: false as const, reason: "sender_not_resolved" as const };

  const { data: existing, error: existingError } = await supabaseServer
    .from("memory_sources")
    .select("id, metadata")
    .eq("canonical_table", "teams_messages")
    .eq("canonical_record_id", messageId)
    .maybeSingle();

  if (existingError) throw new Error(`Could not check Teams Memory source: ${existingError.message}`);

  const priorMetadata = existing?.metadata && typeof existing.metadata === "object"
    ? existing.metadata as Record<string, unknown>
    : {};
  const priorVersion = Number(priorMetadata.memory_ingestion_version ?? 0);

  if (existing && priorVersion >= INGESTION_VERSION) {
    return {
      ingested: false as const,
      reason: "already_ingested" as const,
      sourceId: existing.id,
      entity: resolution.canonicalName,
      ingestionVersion: priorVersion,
    };
  }

  const content = redactSensitiveContent((message.body_text ?? "").trim());
  let sourceId = existing?.id as string | undefined;

  if (!sourceId) {
    const { data: source, error: sourceError } = await supabaseServer
      .from("memory_sources")
      .insert({
        // The current database source_type constraint has no Teams member yet.
        // Keep the canonical source explicit in table/metadata without requiring
        // this code-only architecture change to mutate the production schema.
        source_type: "other",
        title: `Teams message from ${message.sender_display_name ?? resolution.canonicalName}`,
        canonical_table: "teams_messages",
        canonical_record_id: message.message_id,
        content_text: content.slice(0, 1000),
        author_name: message.sender_display_name ?? resolution.canonicalName,
        source_at: message.created_at,
        metadata: { chat_id: message.chat_id, message_type: message.message_type },
      })
      .select("id")
      .single();

    if (sourceError || !source) throw new Error(`Could not create Teams Memory source: ${sourceError?.message ?? "Unknown error"}`);
    sourceId = source.id;
  }

  const establishedSourceId = sourceId!;
  const markProcessed = async (result: string, extra: Record<string, unknown> = {}) => {
    const { error: updateError } = await supabaseServer
      .from("memory_sources")
      .update({ metadata: {
        ...priorMetadata,
        chat_id: message.chat_id,
        message_type: message.message_type,
        memory_ingestion_version: INGESTION_VERSION,
        memory_ingested_at: new Date().toISOString(),
        memory_ingestion_result: result,
        ...extra,
      } })
      .eq("id", establishedSourceId);
    if (updateError) throw new Error(`Could not mark Teams Memory source processed: ${updateError.message}`);
  };

  if (!content) {
    await markProcessed("skipped", { memory_skip_reason: "empty_message" });
    return { ingested: true as const, skipped: true as const, reason: "empty_message" as const,
      sourceId: establishedSourceId, entity: resolution.canonicalName, ingestionVersion: INGESTION_VERSION, claimsCreated: 0 };
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 800,
    system: `Extract only high-value persistent context for Dave Merry's personal AI Chief of Staff.
The Known Person is the Teams message author and the only subject to whom claims may be attached.
Do not summarize. Return at most 2 claims, and return zero unless genuinely worth remembering.
Durable roles, responsibilities, relationships, project associations, decisions, statuses, milestones,
explicit preferences, and important working context qualify. Greetings, routine logistics, links without
explanation, isolated actions presented as permanent ownership, speculation, and credentials do not.
Treat the supplied Teams message date as authoritative for relative dates.
Use only these claimType values: fact, role, responsibility, relationship, project_association, decision,
status, milestone, preference, governing_context, working_context, other.
Return JSON only: {"claims":[{"claimType":"...","statement":"...","evidenceStrength":"weak|moderate|strong"}]}`,
    messages: [{ role: "user", content: `Known Person: ${resolution.canonicalName}\nTeams message date: ${message.created_at ?? "Unknown"}\nMessage:\n${content}` }],
  });

  const raw = response.content.find((item) => item.type === "text");
  const extraction = raw?.type === "text" ? parseJsonObject(raw.text) : { claims: [] };
  const claims = (extraction.claims ?? [])
    .filter((claim) => claim.statement?.trim())
    .slice(0, 2);

  for (const claim of claims) {
    const statement = claim.statement!.trim();
    const claimType = CLAIM_TYPES.has(claim.claimType ?? "") ? claim.claimType! : "other";
    const evidenceStrength = EVIDENCE_STRENGTHS.has(claim.evidenceStrength ?? "") ? claim.evidenceStrength! : "weak";

    await reconcileMemoryClaim({ entityId: resolution.entityId, sourceId: establishedSourceId,
      statement, claimType, evidenceContent: statement, evidenceStrength, effectiveFrom: message.created_at,
      evidenceMetadata: { extraction_type: "claim_candidate", source_type: "teams_message", ingestion_version: INGESTION_VERSION },
      claimMetadata: { source_type: "teams_message", source_id: establishedSourceId, ingestion_version: INGESTION_VERSION },
      reviewTitle: "Review extracted Memory", reviewPriority: 40,
      reviewPayload: { options: ["Confirm", "Outdated", "Keep as evidence", "Not sure", "Dismiss"],
        generated_by: "teams_message_ingestion", ingestion_version: INGESTION_VERSION,
        source_date: message.created_at, source_type: "teams_message", chat_id: message.chat_id },
    });
  }

  await markProcessed("processed", { memory_claims_created: claims.length });
  return { ingested: true as const, sourceId: establishedSourceId, entity: resolution.canonicalName,
    ingestionVersion: INGESTION_VERSION, claimsCreated: claims.length };
}
