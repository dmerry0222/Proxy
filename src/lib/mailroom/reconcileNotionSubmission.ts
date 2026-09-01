import "server-only";

import { emitDiagnosticEvent } from "@/lib/diagnostics/emitEvent";
import { supabaseServer } from "@/lib/supabase/server";
import { getSurfaceMapping, getSurfaceMappingByExternalId } from "@/lib/notion/mapping";
import { readMailroomPage } from "@/lib/notion/readMailroomPage";
import { releaseGuardedBaseline } from "@/lib/notion/guardedProperties";
import { MAILROOM_GUARDED_PROPERTIES } from "@/lib/notion/syncMailroom";
import { planSubmissionReconciliation, type ProxyProposal } from "./submissionReconciliation";

export type NotionSubmissionResult = {
  ok: boolean;
  error: string | null;
  pageId: string | null;
  conversationId: string | null;
  mailroomConversationId: string | null;
  changedFields: string[];
  correctionsRecorded: number;
  /** True when this exact submission had already been reconciled. */
  alreadySubmitted: boolean;
};

function failure(error: string, partial: Partial<NotionSubmissionResult> = {}): NotionSubmissionResult {
  return {
    ok: false,
    error,
    pageId: null,
    conversationId: null,
    mailroomConversationId: null,
    changedFields: [],
    correctionsRecorded: 0,
    alreadySubmitted: false,
    ...partial,
  };
}

/**
 * Reconciles one human-reviewed Notion Mailroom row into Proxy canonical
 * state.
 *
 * Addressable two ways -- by Notion page id (what a row-level button knows)
 * or by canonical Outlook conversation id (what Proxy knows) -- because the
 * eventual Notion button integration sends the former while local testing
 * and any Proxy-side retry naturally have the latter.
 *
 * Deliberately performs NO Outlook mutation and enqueues no execution
 * command. Submitting a row is a REVIEW event: it records what Dave decided
 * and preserves how that differed from what Proxy proposed. Execution stays
 * gated behind the separate explicit Execution Status signal, so clearing
 * a backlog of reviewed rows can never fire a batch of mailbox changes.
 */
export async function reconcileNotionSubmission(input: {
  notionPageId?: string | null;
  conversationId?: string | null;
  traceId: string | null;
}): Promise<NotionSubmissionResult> {
  const { traceId } = input;

  let pageId = input.notionPageId ?? null;

  if (!pageId && input.conversationId) {
    const mapping = await getSurfaceMapping("mailroom_conversation", input.conversationId);
    if (!mapping?.externalObjectId) {
      return failure(`No Notion page is mapped for conversation ${input.conversationId}.`, {
        conversationId: input.conversationId,
      });
    }
    pageId = mapping.externalObjectId;
  }

  if (!pageId) {
    return failure("Either notionPageId or conversationId is required.");
  }

  let page;
  try {
    page = await readMailroomPage(pageId);
  } catch (error) {
    return failure(`Could not read Notion page ${pageId}: ${error instanceof Error ? error.message : "Unknown error"}`, {
      pageId,
    });
  }

  /*
   * Trust the surface_objects mapping over the page's own "Conversation ID"
   * text when both exist: the mapping is Proxy's ledger, while the text
   * property is human-editable in Notion. Fall back to the property only
   * when no mapping row exists for this page.
   */
  const mappingByPage = await getSurfaceMappingByExternalId("mailroom_conversation", pageId);
  const conversationId = mappingByPage?.proxyObjectId ?? page.conversationId;

  if (!conversationId) {
    return failure(`Notion page ${pageId} has no resolvable Mailroom conversation id.`, { pageId });
  }

  const { data: conversation, error } = await supabaseServer
    .from("mailroom_conversations")
    .select(
      "id, conversation_id, category, requested_action, recommended_action, suggested_reply, is_meeting_invitation, review_state"
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return failure(`Could not load Mailroom conversation: ${error.message}`, { pageId, conversationId });
  }
  if (!conversation) {
    return failure(`No Mailroom analysis exists for conversation ${conversationId}.`, { pageId, conversationId });
  }

  const proposal: ProxyProposal = {
    mailroomConversationId: conversation.id as string,
    category: conversation.category as string,
    requestedAction: (conversation.requested_action as string | null) ?? null,
    recommendedAction: (conversation.recommended_action as string | null) ?? null,
    suggestedReply: (conversation.suggested_reply as string | null) ?? null,
    isMeetingInvitation: conversation.is_meeting_invitation === true,
  };

  const plan = planSubmissionReconciliation(proposal, page.reviewed, new Date().toISOString());

  if (plan.rejected) {
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_submission",
      eventType: "submission_rejected",
      status: "failure",
      severity: "warning",
      objectType: "mailroom_conversation",
      objectId: conversationId,
      humanSummary: `Notion Mailroom submission rejected: ${plan.rejected}`,
    });
    return failure(plan.rejected, {
      pageId,
      conversationId,
      mailroomConversationId: proposal.mailroomConversationId,
    });
  }

  /*
   * Idempotency: re-submitting an already-reconciled row must not append a
   * duplicate correction record, which would double-count one human
   * decision as two pieces of calibration evidence.
   */
  const alreadySubmitted = conversation.review_state === "submitted";

  const { error: updateError } = await supabaseServer
    .from("mailroom_conversations")
    .update(plan.conversationPatch)
    .eq("id", proposal.mailroomConversationId);

  if (updateError) {
    return failure(`Could not persist reviewed state: ${updateError.message}`, {
      pageId,
      conversationId,
      mailroomConversationId: proposal.mailroomConversationId,
    });
  }

  let correctionsRecorded = 0;
  if (!alreadySubmitted && plan.corrections.length > 0) {
    const { error: feedbackError } = await supabaseServer.from("mailroom_feedback").insert(plan.corrections);
    if (feedbackError) {
      return failure(`Reviewed state saved, but correction evidence failed: ${feedbackError.message}`, {
        pageId,
        conversationId,
        mailroomConversationId: proposal.mailroomConversationId,
        changedFields: plan.changedFields,
      });
    }
    correctionsRecorded = plan.corrections.length;
    await emitDiagnosticEvent({
      traceId,
      module: "mailroom",
      stage: "notion_submission",
      eventType: "correction_evidence_recorded",
      status: "success",
      objectType: "mailroom_conversation",
      objectId: conversationId,
      humanSummary: `Recorded ${correctionsRecorded} correction record(s) from Dave's review.`,
      metadata: { changedFields: plan.changedFields, correctionsRecorded },
    });
  }

  /*
   * Release the guard. Proxy has just adopted Dave's values as canonical,
   * so the properties are no longer an override -- leaving the stale
   * baseline in place would freeze Bucket and Requested Action forever,
   * because every future sync would keep reading them as human-edited.
   * Also forces the next sweep to actually re-push (the canonical hash is
   * cleared), so Notion reflects the reconciled state rather than sitting
   * on values that only look right by coincidence.
   */
  if (mappingByPage) {
    const releasedBaseline = releaseGuardedBaseline(
      (mappingByPage.metadata?.guardedBaseline as Record<string, string | boolean | null>) ?? {},
      MAILROOM_GUARDED_PROPERTIES
    );
    const { error: releaseError } = await supabaseServer
      .from("surface_objects")
      .update({
        metadata: { ...mappingByPage.metadata, guardedBaseline: releasedBaseline },
        canonical_hash: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mappingByPage.id);

    if (releaseError) {
      // Non-fatal: the review itself is safely recorded. Surface it rather
      // than hide it, since the symptom (frozen fields) is confusing.
      await emitDiagnosticEvent({
        traceId,
        module: "mailroom",
        stage: "notion_submission",
        eventType: "guard_release_failed",
        status: "failure",
        severity: "warning",
        objectType: "mailroom_conversation",
        objectId: conversationId,
        humanSummary: "Submission recorded, but the Notion field guard could not be released",
        technicalDetail: releaseError.message,
      });
    }
  }

  await emitDiagnosticEvent({
    traceId,
    module: "mailroom",
    stage: "notion_submission",
    eventType: "submission_reconciled",
    status: "success",
    objectType: "mailroom_conversation",
    objectId: conversationId,
    humanSummary: plan.changedFields.length
      ? `Reconciled Notion submission; Dave changed: ${plan.changedFields.join(", ")}`
      : "Reconciled Notion submission; Dave accepted Proxy's proposal unchanged",
    metadata: { changedFields: plan.changedFields, alreadySubmitted, pageId },
  });

  return {
    ok: true,
    error: null,
    pageId,
    conversationId,
    mailroomConversationId: proposal.mailroomConversationId,
    changedFields: plan.changedFields,
    correctionsRecorded,
    alreadySubmitted,
  };
}
