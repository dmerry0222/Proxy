import {
  FileArchive,
  FileUp,
} from "lucide-react";

import Link from "next/link";

import ArtifactIntake from "@/components/ingestion/ArtifactIntake";
import { loadRecentIngestions } from "@/lib/ingestion/loadRecentIngestions";

export const dynamic = "force-dynamic";

export default async function IngestionPage() {
  const recent = await loadRecentIngestions();

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-neutral-600"><FileUp size={15} />Knowledge intake</div>
        <h1 className="mt-3 text-2xl font-semibold text-neutral-100">Ingest artifacts</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">Store the original, parse searchable structure, and propose carefully grounded Execute and Memory candidates for review. Meeting processing runs only when the source is meeting-related.</p>
      </div>

      <ArtifactIntake />

      <div className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-950/50 p-4 text-sm text-neutral-400">
        Proposed work from ingested artifacts is reviewed alongside everything else Proxy has reconciled in{" "}
        <Link href="/execute" className="text-amber-400 underline hover:text-amber-300">Execute → Needs review</Link>.
      </div>

      <div className="mt-10">
        <h2 className="text-sm font-medium text-neutral-300">Recent artifacts</h2>
        <div className="mt-3 divide-y divide-neutral-900 overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/50">
          {recent.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-neutral-600">No artifacts have been ingested yet.</div>
          ) : recent.map((artifact) => {
            const meeting = Array.isArray(artifact.meetings) ? artifact.meetings[0] : artifact.meetings;
            return (
              <div key={artifact.id} className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <FileArchive size={17} className="shrink-0 text-neutral-600" />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-neutral-300">{meeting?.title ?? artifact.original_filename}</div>
                    <div className="mt-1 text-xs text-neutral-600">{artifact.content_kind} · {artifact.artifact_type.replaceAll("_", " ")} · {artifact.source_system} · {new Date(artifact.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
                <span className={artifact.processing_status === "completed" ? "text-emerald-500" : artifact.processing_status === "failed" ? "text-red-400" : "text-amber-400"}>{artifact.processing_status}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
