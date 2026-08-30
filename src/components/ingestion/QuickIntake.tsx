"use client";

import {
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  Bold,
  CheckCircle2,
  FileUp,
  Italic,
  Link2,
  List,
  LoaderCircle,
  UploadCloud,
} from "lucide-react";

type Result = {
  duplicate: boolean;
  storedOnly?: boolean;
  sectionsCreated?: number;
  tasksCreated?: number;
  claimsCreated?: number;
  warnings?: string[];
};

function wrapSelection(
  textarea: HTMLTextAreaElement,
  before: string,
  after: string,
  placeholder: string,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd) || placeholder;
  const next =
    value.slice(0, selectionStart) +
    before +
    selected +
    after +
    value.slice(selectionEnd);
  return { next, cursor: selectionStart + before.length + selected.length + after.length };
}

export default function QuickIntake() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function applyMarkdown(before: string, after: string, placeholder: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { next, cursor } = wrapSelection(textarea, before, after, placeholder);
    setText(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setFileName(file.name);
    if (fileInputRef.current) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInputRef.current.files = dataTransfer.files;
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!fileName && !text.trim()) {
      setError("Drop a file or enter some text first");
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const formData = new FormData(event.currentTarget);
      formData.set("artifactType", "other");
      formData.set("contextHint", "auto");
      const response = await fetch("/api/ingestion/artifacts", {
        method: "POST",
        body: formData,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not ingest");
      setResult(body);
      if (!body.duplicate) {
        setText("");
        setFileName(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        formRef.current?.reset();
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown ingestion error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
      <div className="text-sm font-medium text-neutral-300">
        Quick capture
      </div>

      <p className="mt-1 text-xs text-neutral-500">
        Drop a file or jot something down — Proxy will file it away.
      </p>

      <form ref={formRef} onSubmit={submit} className="mt-4 grid gap-4 md:grid-cols-2">
        <label
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer.files);
          }}
          className={[
            "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center transition",
            dragging
              ? "border-neutral-500 bg-neutral-900"
              : "border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900/50",
          ].join(" ")}
        >
          <UploadCloud size={20} className="text-neutral-600" />
          <span className="mt-2 block text-sm text-neutral-300">
            {fileName ?? "Drag & drop a file, or click to choose"}
          </span>
          <span className="mt-1 block text-xs text-neutral-600">
            Markdown, text, VTT, JSON, PDF, or DOCX · up to 50 MB
          </span>
          <input
            ref={fileInputRef}
            name="file"
            type="file"
            accept=".md,.txt,.vtt,.json,.pdf,.docx"
            className="sr-only"
            onChange={(event) => handleFiles(event.currentTarget.files)}
          />
        </label>

        <div className="rounded-lg border border-neutral-800 bg-neutral-950 focus-within:border-neutral-600">
          <div className="flex items-center gap-1 border-b border-neutral-900 px-2 py-1.5">
            <button
              type="button"
              title="Bold"
              onClick={() => applyMarkdown("**", "**", "bold text")}
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            >
              <Bold size={13} />
            </button>
            <button
              type="button"
              title="Italic"
              onClick={() => applyMarkdown("_", "_", "italic text")}
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            >
              <Italic size={13} />
            </button>
            <button
              type="button"
              title="Bulleted list"
              onClick={() => applyMarkdown("\n- ", "", "list item")}
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            >
              <List size={13} />
            </button>
            <button
              type="button"
              title="Link"
              onClick={() => applyMarkdown("[", "](https://)", "label")}
              className="rounded p-1.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            >
              <Link2 size={13} />
            </button>
            <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-neutral-700">
              Markdown
            </span>
          </div>
          <textarea
            ref={textareaRef}
            name="text"
            rows={6}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder="Paste or type a quick note…"
            className="w-full resize-y rounded-b-lg bg-transparent px-3 py-2.5 font-mono text-sm leading-6 text-neutral-300 outline-none placeholder:text-neutral-700"
          />
        </div>

        <label className="md:col-span-2 text-xs text-neutral-500">
          What should Proxy do with this? <span className="text-neutral-700">Optional — e.g. “remember this for graduate strategy” or “I need to send this to Heather tomorrow”</span>
          <input name="userIntent" className="mt-2 block w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5 text-sm text-neutral-300 outline-none placeholder:text-neutral-700 focus:border-neutral-600" placeholder="Your intent, kept separate from the source material" />
        </label>

        <div className="md:col-span-2 flex items-center justify-end gap-3">
          {error && <span className="text-xs text-red-300">{error}</span>}
          {result && !error && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-300">
              <CheckCircle2 size={13} />
              {result.duplicate ? "Already captured" : "Captured"}
            </span>
          )}
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-wait disabled:opacity-50"
          >
            {saving ? <LoaderCircle size={15} className="animate-spin" /> : <FileUp size={15} />}
            {saving ? "Saving…" : "Capture"}
          </button>
        </div>
      </form>
    </section>
  );
}
