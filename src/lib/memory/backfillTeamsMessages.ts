import "server-only";

import { ingestTeamsMessageToMemory } from "@/lib/memory/ingestTeamsMessage";
import { supabaseServer } from "@/lib/supabase/server";

export async function backfillRecentTeamsMessages({ days = 30, limit = 25 }: { days?: number; limit?: number } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabaseServer.from("teams_messages")
    .select("message_id, sender_display_name, created_at, body_text, sender_user_id")
    .gte("created_at", since).not("body_text", "is", null).neq("body_text", "")
    .not("sender_user_id", "is", null).order("created_at", { ascending: false }).limit(Math.max(limit * 4, 100));

  if (error) throw new Error(`Could not load Teams messages for Memory backfill: ${error.message}`);

  const senderIds = [...new Set((data ?? []).map((row) => row.sender_user_id).filter((id): id is string => Boolean(id)))];
  const { data: people, error: peopleError } = await supabaseServer.from("org_chart")
    .select("employeeid, employeeemail").in("employeeid", senderIds);
  if (peopleError) throw new Error(`Could not identify Teams senders for Memory backfill: ${peopleError.message}`);

  const daveIds = new Set((people ?? [])
    .filter((person) => person.employeeemail?.toLowerCase() === "dmerry@suffolk.edu")
    .map((person) => person.employeeid));
  const selected = (data ?? []).filter((row) => !daveIds.has(row.sender_user_id)).slice(0, limit);

  const results = [];
  for (const message of selected) {
    try {
      results.push({ messageId: message.message_id, sender: message.sender_display_name, createdAt: message.created_at,
        result: await ingestTeamsMessageToMemory(message.message_id) });
    } catch (cause) {
      results.push({ messageId: message.message_id, sender: message.sender_display_name, createdAt: message.created_at,
        result: { ingested: false as const, reason: "backfill_error" as const,
          error: cause instanceof Error ? cause.message : "Unknown Teams Memory ingestion error" } });
    }
  }

  return { requested: limit, selected: selected.length, results };
}
