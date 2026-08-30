/**
 * Pure reconciliation of a human-reviewed Notion Mailroom row against the
 * Proxy proposal it was generated from. Zero-import leaf module so it is
 * directly unit testable and so "what did the human actually change, and is
 * that change legal" is decided in one place, independent of Notion or
 * Supabase.
 *
 * The central rule: a submission never overwrites the proposal in place. It
 * produces (a) a patch carrying the human's final values forward and (b)
 * explicit correction records preserving BOTH the original proposal and the
 * reviewed value. Losing the proposal would destroy the only signal that
 * says the classifier was wrong -- which is the entire point of capturing
 * it.
 */

/* Keep in sync with CATEGORY_LABELS in actionModel.ts. Duplicated rather
 * than imported to keep this module import-free and unit-testable. */
const LABEL_TO_CATEGORY: Record<string, string> = {
  "Needs You": "needs_you",
  FYI: "fyi",
  "Professional News": "professional_news",
  "Low Value": "low_value",
  Calendar: "calendar",
  Workday: "workday",
};

/* Keep in sync with ACTION_LABELS in actionModel.ts. */
const LABEL_TO_ACTION: Record<string, string> = {
  Archive: "archive",
  "Needs Attention": "needs_attention",
  "Draft Reply": "draft_reply",
  "Accept Invite": "accept_invite",
  None: "none",
};

export function categoryFromLabel(label: string | null): string | null {
  return label ? (LABEL_TO_CATEGORY[label] ?? null) : null;
}

export function actionFromLabel(label: string | null): string | null {
  return label ? (LABEL_TO_ACTION[label] ?? null) : null;
}

/** Proxy's canonical proposal, as stored before review. */
export type ProxyProposal = {
  mailroomConversationId: string;
  category: string;
  requestedAction: string | null;
  recommendedAction: string | null;
  suggestedReply: string | null;
  isMeetingInvitation: boolean;
};

/** What the human left in the Notion row. */
export type ReviewedValues = {
  bucketLabel: string | null;
  requestedActionLabel: string | null;
  humanReplyEdit: string | null;
  humanInstruction: string | null;
  submitted: boolean;
};

export type CorrectionRecord = {
  mailroom_conversation_id: string;
  feedback_source: "notion";
  feedback_text: string | null;
  original_category: string | null;
  corrected_category: string | null;
  original_action: string | null;
  corrected_action: string | null;
  original_suggested_reply: string | null;
  corrected_reply: string | null;
};

export type SubmissionPlan = {
  /** Non-null when the submission is refused outright. */
  rejected: string | null;
  /** Columns to write to mailroom_conversations. */
  conversationPatch: Record<string, unknown>;
  /** Correction evidence rows; empty when the human changed nothing. */
  corrections: CorrectionRecord[];
  /** Human-readable list of what the human actually changed. */
  changedFields: string[];
};

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `submittedAt` is passed in rather than read from the clock so the result
 * is deterministic and testable.
 */
export function planSubmissionReconciliation(
  proposal: ProxyProposal,
  reviewed: ReviewedValues,
  submittedAt: string
): SubmissionPlan {
  const empty: SubmissionPlan = { rejected: null, conversationPatch: {}, corrections: [], changedFields: [] };

  if (!reviewed.submitted) {
    return {
      ...empty,
      rejected: "Row is not marked Submitted in Notion; nothing to reconcile.",
    };
  }

  const reviewedCategory = categoryFromLabel(reviewed.bucketLabel);
  if (reviewed.bucketLabel !== null && reviewedCategory === null) {
    return { ...empty, rejected: `Unrecognized Bucket value in Notion: "${reviewed.bucketLabel}"` };
  }

  const reviewedAction = actionFromLabel(reviewed.requestedActionLabel);
  if (reviewed.requestedActionLabel !== null && reviewedAction === null) {
    return { ...empty, rejected: `Unrecognized Requested Action value in Notion: "${reviewed.requestedActionLabel}"` };
  }

  /*
   * The accept_invite safety gate, enforced again here. A human selecting
   * "Accept Invite" in Notion is not evidence the item IS an invitation --
   * only the deterministic invitation gate is. Rejecting rather than
   * silently downgrading, so a wrong selection is visible instead of
   * quietly becoming something else.
   */
  if (reviewedAction === "accept_invite" && !proposal.isMeetingInvitation) {
    return {
      ...empty,
      rejected: "accept_invite is only valid for a positively identified meeting invitation.",
    };
  }

  const finalCategory = reviewedCategory ?? proposal.category;
  const finalAction = reviewedAction ?? proposal.requestedAction;
  const replyEdit = normalizeText(reviewed.humanReplyEdit);
  const instruction = normalizeText(reviewed.humanInstruction);

  const changedFields: string[] = [];
  if (reviewedCategory !== null && reviewedCategory !== proposal.category) changedFields.push("category");
  if (reviewedAction !== null && reviewedAction !== proposal.requestedAction) changedFields.push("requested_action");
  if (replyEdit !== null) changedFields.push("human_reply_edit");
  if (instruction !== null) changedFields.push("human_instruction");

  const conversationPatch: Record<string, unknown> = {
    category: finalCategory,
    requested_action: finalAction,
    human_reply_edit: replyEdit,
    human_instruction: instruction,
    review_state: "submitted",
    submitted_at: submittedAt,
    reviewed_via: "notion",
  };

  /*
   * Provenance only moves to "notion" when the human actually chose an
   * action there. Submitting a row while leaving Proxy's proposal alone is
   * an endorsement, not a selection, and mislabeling it would corrupt the
   * "how often does Dave override us" signal.
   */
  if (reviewedAction !== null && reviewedAction !== proposal.requestedAction) {
    conversationPatch.selected_action_source = "notion";
  }

  const corrections: CorrectionRecord[] = [];
  const categoryChanged = changedFields.includes("category");
  const actionChanged = changedFields.includes("requested_action");

  if (categoryChanged || actionChanged || replyEdit !== null || instruction !== null) {
    corrections.push({
      mailroom_conversation_id: proposal.mailroomConversationId,
      feedback_source: "notion",
      feedback_text: instruction,
      original_category: categoryChanged ? proposal.category : null,
      corrected_category: categoryChanged ? finalCategory : null,
      // The proposal being corrected is what Proxy RECOMMENDED, falling
      // back to what was stored as requested when no separate
      // recommendation was recorded.
      original_action: actionChanged ? (proposal.recommendedAction ?? proposal.requestedAction) : null,
      corrected_action: actionChanged ? finalAction : null,
      original_suggested_reply: replyEdit !== null ? proposal.suggestedReply : null,
      corrected_reply: replyEdit,
    });
  }

  return { rejected: null, conversationPatch, corrections, changedFields };
}
