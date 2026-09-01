import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { hasCurrentMailroomAnalysis } from "@/lib/mailroom/analysisReadiness";
import { loadMailroomConversations } from "@/lib/mailroom/loadMailroom";
import { loadLatestStoredMailroomAnalyses } from "@/lib/mailroom/loadLatestMailroomRun";

export type ReopenStaleResult = {
  reopenedMessages: number;
  conversationIds: string[];
};

/**
 * runMailroomAnalysis()'s existing selection query only considers `emails`
 * rows where `is_in_inbox = true AND processed = false` -- a flag that
 * predates Notion review and is otherwise only ever flipped back to true by
 * the bespoke Mailroom UI's own review action (markMessagesProcessed in
 * app/api/mailroom/review/route.ts), not by anything about whether Mailroom
 * AI analysis is current.
 *
 * That means a conversation whose newest Inbox message happens to already
 * carry `processed = true` (e.g. because Dave reviewed an OLDER message on
 * the same thread through the old UI before this one arrived) is invisible
 * to runMailroomAnalysis()'s selection query even though its stored
 * analysis is stale by hasCurrentMailroomAnalysis's definition. This
 * reopens exactly those conversations -- resetting `processed = false` on
 * their live Inbox rows -- so the UNMODIFIED runMailroomAnalysis()
 * selection picks them up on its next run. Conversations with no stored
 * analysis at all are already unprocessed and need no repair.
 *
 * Deliberately data repair only: no analysis/business logic here, and
 * runMailroomAnalysis() itself is never touched.
 */
export async function reopenStaleMailroomConversations(): Promise<ReopenStaleResult> {
  const liveConversations = await loadMailroomConversations({ includeProcessed: true, limit: 1000 });
  if (liveConversations.length === 0) {
    return { reopenedMessages: 0, conversationIds: [] };
  }

  const analysisByConversation = await loadLatestStoredMailroomAnalyses(
    liveConversations.map((conversation) => conversation.conversationId)
  );

  const staleConversationIds: string[] = [];

  for (const conversation of liveConversations) {
    const analysis = analysisByConversation.get(conversation.conversationId);
    if (!analysis) continue; // never analyzed -- already unprocessed, nothing to reopen

    const current = hasCurrentMailroomAnalysis({
      mailroomConversationId: analysis.id,
      analysisMessageId: analysis.latest_message_id,
      currentMessageId: conversation.latestMessageId,
    });

    if (!current) {
      staleConversationIds.push(conversation.conversationId);
    }
  }

  if (staleConversationIds.length === 0) {
    return { reopenedMessages: 0, conversationIds: [] };
  }

  const { data: reopenedRows, error } = await supabaseServer
    .from("emails")
    .update({ processed: false })
    .in("conversation_id", staleConversationIds)
    .eq("is_in_inbox", true)
    .select("outlook_message_id");

  if (error) {
    throw new Error(`Could not reopen stale Mailroom conversations for reanalysis: ${error.message}`);
  }

  return { reopenedMessages: reopenedRows?.length ?? 0, conversationIds: staleConversationIds };
}
