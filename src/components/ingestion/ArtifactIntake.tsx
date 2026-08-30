"use client";

import {
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  FileUp,
  LoaderCircle,
} from "lucide-react";

type Result = {
  duplicate: boolean;
  storedOnly?: boolean;
  sectionsCreated?: number;
  tasksCreated?: number;
  claimsCreated?: number;
  calendarMatch?: {
    subject: string | null;
    score: number;
    status: string;
  } | null;
  warnings?: string[];
};

export default function ArtifactIntake() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/ingestion/artifacts", {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not ingest artifact");
      setResult(body);
      if (!body.duplicate) formRef.current?.reset();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown ingestion error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="space-y-5 rounded-2xl border border-neutral-800 bg-neutral-950/60 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
          Artifact type
          <select name="artifactType" defaultValue="other" className="block w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm normal-case tracking-normal text-neutral-200 outline-none focus:border-neutral-600">
            <option value="other">General document</option>
            <option value="summary">Summary</option>
            <option value="transcript">Transcript</option>
            <option value="personal_notes">Personal notes</option>
            <option value="agenda">Agenda</option>
            <option value="chat_export">Chat export</option>
            <option value="attachment">Attachment</option>
            <option value="recording">Recording</option>
          </select>
        </label>

        <label className="space-y-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
          Source date and time
          <input name="occurredAt" type="datetime-local" className="block w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm normal-case tracking-normal text-neutral-200 outline-none focus:border-neutral-600" />
        </label>
      </div>

      <label className="space-y-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
        Context
        <select name="contextHint" defaultValue="auto" className="block w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm normal-case tracking-normal text-neutral-200 outline-none focus:border-neutral-600">
          <option value="auto">Auto — meeting only when obvious</option>
          <option value="general">General artifact</option>
          <option value="meeting">Meeting-related</option>
        </select>
      </label>

      <label className="space-y-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
        Title
        <input name="title" placeholder="Optional when frontmatter supplies a title" className="block w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm normal-case tracking-normal text-neutral-200 outline-none placeholder:text-neutral-700 focus:border-neutral-600" />
      </label>

      <label className="block cursor-pointer rounded-xl border border-dashed border-neutral-800 px-5 py-6 text-center transition hover:border-neutral-700 hover:bg-neutral-900/50">
        <FileUp size={20} className="mx-auto text-neutral-600" />
        <span className="mt-2 block text-sm text-neutral-300">Choose an artifact</span>
        <span className="mt-1 block text-xs text-neutral-600">Markdown, text, VTT, JSON, PDF, or DOCX · up to 50 MB</span>
        <input name="file" type="file" accept=".md,.txt,.vtt,.json,.pdf,.docx" className="sr-only" />
      </label>

      <div className="flex items-center gap-3 text-xs uppercase tracking-[0.14em] text-neutral-700">
        <span className="h-px flex-1 bg-neutral-900" />or paste content<span className="h-px flex-1 bg-neutral-900" />
      </div>

      <textarea name="text" rows={10} placeholder={'---\ntitle: Weekly project sync\nmeeting_at: 2026-08-27T14:00:00-04:00\nparticipants:\n  - person@suffolk.edu\n---\n\n## Next Steps\n...'} className="w-full resize-y rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 font-mono text-sm leading-6 text-neutral-300 outline-none placeholder:text-neutral-800 focus:border-neutral-600" />

      <label className="space-y-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-600">
        Your intent <span className="normal-case tracking-normal text-neutral-700">(optional and separate from source content)</span>
        <input name="userIntent" placeholder="Remember this for X; I need to do Y; save this for later…" className="block w-full rounded-xl border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm normal-case tracking-normal text-neutral-200 outline-none placeholder:text-neutral-700 focus:border-neutral-600" />
      </label>

      <button type="submit" disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-100 px-4 py-3 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-50">
        {saving ? <LoaderCircle size={17} className="animate-spin" /> : <FileUp size={17} />}
        {saving ? "Storing and processing…" : "Ingest artifact"}
      </button>

      {error && <div className="rounded-xl border border-red-950 bg-red-950/20 px-4 py-3 text-sm text-red-300">{error}</div>}
      {result && (
        <div className="rounded-xl border border-emerald-950 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200">
          <div className="flex items-center gap-2 font-medium"><CheckCircle2 size={16} />{result.duplicate ? "Already ingested" : result.storedOnly ? "Stored for a future parser" : "Ingestion complete"}</div>
          {!result.duplicate && !result.storedOnly && <div className="mt-2 text-xs leading-5 text-emerald-400/80">{result.sectionsCreated ?? 0} sections · {result.tasksCreated ?? 0} task candidates · {result.claimsCreated ?? 0} Memory candidates{result.calendarMatch ? ` · Calendar match: ${result.calendarMatch.subject ?? "Untitled"} (${result.calendarMatch.status})` : ""}</div>}
          {result.warnings?.map((warning) => <div key={warning} className="mt-2 text-xs text-amber-300">{warning}</div>)}
        </div>
      )}
    </form>
  );
}
