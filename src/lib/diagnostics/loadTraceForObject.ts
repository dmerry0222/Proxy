import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

export async function loadTraceIdForObject(objectType: string, objectId: string): Promise<string | null> {
  const { data, error } = await supabaseServer
    .from("diagnostic_events")
    .select("trace_id")
    .eq("object_type", objectType)
    .eq("object_id", objectId)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not resolve trace for object: ${error.message}`);
  }

  return data?.trace_id ?? null;
}
