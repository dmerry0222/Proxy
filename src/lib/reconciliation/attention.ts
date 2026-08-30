import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

/**
 * Routes a reconciliation outcome that needs human confirmation through
 * the existing execute_attention_items architecture (Brief Part 14)
 * rather than inventing a parallel notification/review mechanism.
 * Deliberately non-interrupting: urgency defaults to weekly_review, never
 * interrupt_now -- routine reconciliation candidates are not emergencies.
 *
 * `dedupeKey` should be stable for the same underlying signal (e.g. the
 * same execution item proposed complete twice) so reprocessing doesn't
 * pile up duplicate attention items -- relies on
 * execute_attention_items_pending_dedupe_idx (unique on dedupe_key where
 * status='pending').
 */
export async function createReconciliationAttentionItem(input: {
  kind: "proposed_completion" | "proposed_cancellation" | "ambiguous_merge" | "project_nomination" | "waiting_overdue" | "priority_conflict";
  executionItemId?: string | null;
  title: string;
  detail: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: existingError } = await supabaseServer
    .from("execute_attention_items")
    .select("id")
    .eq("dedupe_key", input.dedupeKey)
    .eq("status", "pending")
    .maybeSingle();

  if (existingError) {
    throw new Error(`Could not check for an existing attention item: ${existingError.message}`);
  }
  if (existing) {
    return { id: existing.id as string, created: false };
  }

  const { data, error } = await supabaseServer
    .from("execute_attention_items")
    .insert({
      kind: input.kind,
      execution_item_id: input.executionItemId ?? null,
      urgency: "weekly_review",
      audience: "dave",
      status: "pending",
      title: input.title,
      detail: input.detail,
      dedupe_key: input.dedupeKey,
      payload: input.payload ?? {},
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Could not create attention item: ${error?.message ?? "Unknown error"}`);
  }

  return { id: data.id as string, created: true };
}
