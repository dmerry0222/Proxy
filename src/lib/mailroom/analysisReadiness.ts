/**
 * Pure, zero-import leaf module (same shape as actionModel.ts /
 * executionTarget.ts) deciding whether a conversation's stored Mailroom
 * analysis is CURRENT -- i.e. safe to present in Notion as a
 * reviewable/submittable row -- as distinct from merely existing.
 *
 * Root cause this exists to prevent (Aug 2026 incident): the Mailroom ->
 * Notion projection pushed every live Inbox conversation, including ones
 * with no analysis at all (a display-only fallback the bespoke Mailroom UI
 * uses so it always has something to render) or a genuinely stale one (a
 * newer thread message arrived since analysis ran). Both looked identical
 * to "hasStoredAnalysis: true" under the looser continuity check that UI
 * uses purely for display purposes. This predicate is the one explicit,
 * testable definition of "actually current" that projection/backfill/repair
 * code gates on instead.
 */
export type MailroomAnalysisReadiness = {
  /** mailroom_conversations.id for the stored analysis, if any. */
  mailroomConversationId: string | null;
  /** mailroom_conversations.latest_message_id for the stored analysis, if any. */
  analysisMessageId: string | null;
  /** The conversation's actual current latest message id (live thread state). */
  currentMessageId: string;
};

export function hasCurrentMailroomAnalysis(input: MailroomAnalysisReadiness): boolean {
  return (
    input.mailroomConversationId !== null &&
    input.analysisMessageId !== null &&
    input.analysisMessageId === input.currentMessageId
  );
}
