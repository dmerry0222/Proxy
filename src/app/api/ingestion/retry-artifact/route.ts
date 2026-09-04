import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { retryArtifactExtraction } from "@/lib/ingestion/retryArtifactExtraction";

/**
 * Priority 4: manual retry trigger for a failed process_artifact job, one
 * artifact at a time. Meant for the small, known backlog of malformed-JSON
 * failures the structured-output fix addresses, not a bulk sweep -- an
 * artifact that fails for a real content reason (not the JSON bug) should
 * not be silently retried forever.
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

  const body = await request.json().catch(() => null);
  const artifactId = body?.artifactId;
  if (typeof artifactId !== "string" || !artifactId) {
    return NextResponse.json({ success: false, error: "artifactId (string) is required." }, { status: 400 });
  }

  try {
    const result = await retryArtifactExtraction(artifactId);
    return NextResponse.json({ success: true, artifactId, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown retry error";
    return NextResponse.json({ success: false, artifactId, error: message }, { status: 500 });
  }
}
