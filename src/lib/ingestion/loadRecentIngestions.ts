import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

export async function loadRecentIngestions() {
  const { data, error } = await supabaseServer.from("artifacts")
    .select(`id, artifact_type, content_kind, original_filename, source_system, parser_status,
      processing_status, created_at, meetings ( id, title, scheduled_start )`)
    .order("created_at", { ascending: false }).limit(12);
  if (error) throw new Error(`Could not load recent ingestions: ${error.message}`);
  return data ?? [];
}
