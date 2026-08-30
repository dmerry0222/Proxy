import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { processTeamsConversationDelta } from "@/lib/memory/processTeamsConversationDelta";

/*
 * The sync-complete signal tells Memory when to look; the per-chat
 * high-water-mark (inside processTeamsConversationDelta) tells it what is
 * actually new. This function only needs to discover which chats this
 * sync run touched at all.
 */
export async function processTeamsSyncRun(runGuid: string) {
  const { data, error } = await supabaseServer
    .from("teams_messages")
    .select("chat_id")
    .eq("run_guid", runGuid)
    .not("chat_id", "is", null);

  if (error) {
    throw new Error(`Could not load Teams messages for sync run ${runGuid}: ${error.message}`);
  }

  const chatIds = [
    ...new Set(
      (data ?? [])
        .map((row) => row.chat_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];

  const results = [];

  for (const chatId of chatIds) {
    try {
      results.push({ chatId, result: await processTeamsConversationDelta(chatId) });
    } catch (cause) {
      console.error(`Teams Memory conversation processing failed for chat ${chatId}:`, cause);
      results.push({
        chatId,
        error: cause instanceof Error ? cause.message : "Unknown error",
      });
    }
  }

  return { runGuid, chatsProcessed: chatIds.length, results };
}
