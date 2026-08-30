import { NextResponse } from "next/server";

import { ingestArtifact } from "@/lib/ingestion/ingestArtifact";
import type { ArtifactContextHint, ArtifactType } from "@/lib/ingestion/types";

export const runtime = "nodejs";

const ARTIFACT_TYPES = new Set<ArtifactType>([
  "transcript", "summary", "personal_notes", "agenda", "chat_export",
  "recording", "attachment", "other",
]);
const MAX_BYTES = 50 * 1024 * 1024;
const CONTEXT_HINTS = new Set<ArtifactContextHint>(["auto", "general", "meeting"]);

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const pastedText = String(form.get("text") ?? "").trim();
    const rawType = String(form.get("artifactType") ?? "summary") as ArtifactType;
    const contextHint = String(form.get("contextHint") ?? "auto") as ArtifactContextHint;
    if (!ARTIFACT_TYPES.has(rawType)) {
      return NextResponse.json({ error: "Invalid artifact type" }, { status: 400 });
    }
    if (!CONTEXT_HINTS.has(contextHint)) {
      return NextResponse.json({ error: "Invalid context hint" }, { status: 400 });
    }

    let filename: string;
    let mimeType: string;
    let bytes: Uint8Array;
    let submissionKind: "file" | "pasted_text";

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: "Files must be 50 MB or smaller" }, { status: 413 });
      }
      filename = file.name || "artifact.bin";
      mimeType = file.type || "application/octet-stream";
      bytes = new Uint8Array(await file.arrayBuffer());
      submissionKind = "file";
    } else if (pastedText) {
      filename = String(form.get("filename") ?? "pasted-notes.md").trim() || "pasted-notes.md";
      mimeType = "text/markdown";
      bytes = new TextEncoder().encode(pastedText);
      submissionKind = "pasted_text";
    } else {
      return NextResponse.json({ error: "Choose a file or paste document text" }, { status: 400 });
    }

    const result = await ingestArtifact({
      artifactType: rawType,
      sourceSystem: "manual",
      filename,
      mimeType,
      bytes,
      title: String(form.get("title") ?? "").trim() || null,
      occurredAt: String(form.get("occurredAt") ?? "").trim() || null,
      contextHint,
      userIntent: String(form.get("userIntent") ?? "").trim() || null,
      submissionKind,
      metadata: { intake: "proxy_manual_upload" },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Artifact ingestion failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown ingestion error" }, { status: 500 });
  }
}
