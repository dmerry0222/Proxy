import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";
import type { DiagnosticIssue } from "@/lib/diagnostics/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? "open";

    const { data, error } = await supabaseServer
      .from("diagnostic_issues")
      .select("*")
      .eq("status", status)
      .order("last_observed_at", { ascending: false })
      .limit(50);

    if (error) {
      throw new Error(`Could not load issues: ${error.message}`);
    }

    return NextResponse.json({ success: true, result: (data ?? []) as DiagnosticIssue[] });
  } catch (error) {
    console.error("Inspector General issues lookup failed:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown Inspector General issues error",
      },
      { status: 500 },
    );
  }
}
