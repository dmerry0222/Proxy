import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

export async function reconcileWorkBlocksFromCalendar() {
  const { data: blocks, error: blockError } = await supabaseServer.from("execute_work_blocks")
    .select("id, planned_start, planned_end, movement_history")
    .not("provider_request_id", "is", null)
    .in("status", ["proposed", "committed", "partial", "missed"]);
  if (blockError) throw new Error(`Could not load work blocks for reconciliation: ${blockError.message}`);
  if (!blocks?.length) return { reconciled: 0, moved: 0 };

  const horizonStart = new Date();
  horizonStart.setDate(horizonStart.getDate() - 30);
  const horizonEnd = new Date();
  horizonEnd.setDate(horizonEnd.getDate() + 60);
  const { data: events, error: eventError } = await supabaseServer.from("calendar_events")
    .select("event_id, start_time, end_time, body_preview, body_html")
    .gte("end_time", horizonStart.toISOString()).lte("start_time", horizonEnd.toISOString());
  if (eventError) throw new Error(`Could not load Outlook events for reconciliation: ${eventError.message}`);

  let reconciled = 0;
  let moved = 0;
  for (const block of blocks) {
    const marker = `Proxy work block: ${block.id}`;
    const event = (events ?? []).find((candidate) =>
      candidate.body_preview?.includes(marker) || candidate.body_html?.includes(marker));
    if (!event?.start_time || !event.end_time) continue;
    const didMove = event.start_time !== block.planned_start || event.end_time !== block.planned_end;
    const history = Array.isArray(block.movement_history) ? block.movement_history : [];
    const now = new Date().toISOString();
    const { error: updateError } = await supabaseServer.from("execute_work_blocks").update({
      calendar_event_id: event.event_id,
      planned_start: event.start_time,
      planned_end: event.end_time,
      last_reconciled_at: now,
      updated_at: now,
      movement_history: didMove ? [...history, {
        from: { start: block.planned_start, end: block.planned_end },
        to: { start: event.start_time, end: event.end_time },
        actor: "outlook",
        at: now,
      }].slice(-20) : history,
    }).eq("id", block.id);
    if (updateError) throw new Error(`Could not reconcile work block ${block.id}: ${updateError.message}`);
    await supabaseServer.from("execute_calendar_outbox").update({
      status: "reconciled", reconciled_at: now, updated_at: now,
    }).eq("work_block_id", block.id).in("status", ["pending", "sent", "failed"]);
    reconciled += 1;
    if (didMove) moved += 1;
  }
  return { reconciled, moved };
}

