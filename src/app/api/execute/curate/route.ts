import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { refreshExecuteCuration } from "@/lib/execute/refreshCuration";

/**
 * Recomputes which execution items belong in Curated Execute, and writes the
 * reason for each decision onto the item.
 *
 * Separate from intake so curation can be re-run on its own after editing
 * curationPolicy.ts -- the whole point of the policy being a pure module is
 * that you can change the rule and immediately see, in the "All Execution
 * Items" view, exactly what moved and why.
 */
export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  try {
    const curation = await refreshExecuteCuration();
    return NextResponse.json({ success: true, curation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown curation error";
    console.error("Execute curation refresh failed:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
