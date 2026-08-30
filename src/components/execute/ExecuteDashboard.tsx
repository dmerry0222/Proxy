"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

import type { ExecuteDashboard as Dashboard, ExecuteWorkBlock } from "@/lib/execute/types";
import type { ReviewEntry } from "@/lib/execute/reviewTypes";
import ReconciliationReview from "@/components/execute/ReconciliationReview";

const DAY_MS = 86_400_000;

function dayKey(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDay(value: Date, long = false) {
  return new Intl.DateTimeFormat(undefined, long
    ? { weekday: "long", month: "short", day: "numeric" }
    : { weekday: "short", day: "numeric" }).format(value);
}

async function mutate(body: Record<string, unknown>) {
  const response = await fetch("/api/execute/mutations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error ?? "Execute could not save that change");
  return payload.result;
}

export default function ExecuteDashboard({ initialDashboard, reviewEntries }: { initialDashboard: Dashboard; reviewEntries: ReviewEntry[] }) {
  const router = useRouter();
  const [selectedBlock, setSelectedBlock] = useState<ExecuteWorkBlock | null>(null);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [showItemForm, setShowItemForm] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 14 }, (_, index) => {
    const date = new Date(initialDashboard.horizonStart);
    date.setTime(date.getTime() + index * DAY_MS);
    return date;
  }), [initialDashboard.horizonStart]);

  const openItems = initialDashboard.items.filter((item) => item.status === "active" && item.responsibility === "mine");
  const waitingOn = initialDashboard.items.filter((item) => item.status === "active" && item.responsibility === "external");
  const upcoming = initialDashboard.items
    .filter((item) => item.status === "active" && item.timingAt)
    .sort((a, b) => new Date(a.timingAt as string).getTime() - new Date(b.timingAt as string).getTime())
    .slice(0, 8);
  const today = dayKey(new Date());
  const todayBlocks = initialDashboard.workBlocks.filter((block) => dayKey(block.start) === today);
  const todayEvents = initialDashboard.calendarEvents.filter((event) => dayKey(event.start) === today);

  async function run(action: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      setShowItemForm(false);
      setShowBlockForm(false);
      setSelectedItemIds([]);
      setSelectedBlock(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown Execute error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pb-24 lg:pb-0">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-amber-500/70">
            <Sparkles size={14} /> Planning and doing
          </div>
          <h1 className="mt-2 text-2xl font-semibold text-neutral-100">Execute</h1>
          <p className="mt-1 text-sm text-neutral-500">Protect the time. Arrive ready.</p>
        </div>
        <div className="flex gap-2">
          {!!initialDashboard.availableMemoryProjects.length && <button onClick={() => setShowProjectForm((value) => !value)} className="rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-900">Activate project</button>}
          <button onClick={() => setShowItemForm((value) => !value)} className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900">
            <Plus size={15} /> Add work
          </button>
          <button disabled={!selectedItemIds.length} onClick={() => setShowBlockForm((value) => !value)} className="flex items-center gap-2 rounded-lg bg-amber-400 px-3 py-2 text-sm font-medium text-neutral-950 disabled:opacity-35">
            <CalendarDays size={15} /> Protect time
          </button>
        </div>
      </header>

      {error && <div className="mb-4 rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</div>}

      {showProjectForm && <ProjectForm projects={initialDashboard.availableMemoryProjects} saving={saving} onSubmit={(payload) => run(() => mutate(payload))} />}
      {showItemForm && <ItemForm projects={initialDashboard.projects} saving={saving} onSubmit={(payload) => run(() => mutate(payload))} />}
      {showBlockForm && <BlockForm items={openItems.filter((item) => selectedItemIds.includes(item.id))} saving={saving} onSubmit={(payload) => run(() => mutate(payload))} />}

      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
          <h2 className="text-sm font-medium text-neutral-300">Needs review</h2>
          <div className="mt-3"><ReconciliationReview entries={reviewEntries} /></div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
          <h2 className="text-sm font-medium text-neutral-300">Waiting on</h2>
          <div className="mt-3 space-y-2">
            {waitingOn.map((item) => (
              <div key={item.id} className="rounded-xl border border-neutral-800 p-3">
                <div className="text-sm text-neutral-200">{item.relatedPersonName ? `Waiting on ${item.relatedPersonName}` : "Waiting"} — {item.title}</div>
                {item.expectedAt && <div className="mt-1 text-xs text-neutral-500">Expected {formatTime(item.expectedAt)}</div>}
              </div>
            ))}
            {!waitingOn.length && <div className="text-sm text-neutral-600">Nothing outstanding from other people.</div>}
          </div>
        </div>
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
          <h2 className="text-sm font-medium text-neutral-300">Upcoming / timing</h2>
          <div className="mt-3 space-y-2">
            {upcoming.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-neutral-800 p-3">
                <div className="min-w-0 truncate text-sm text-neutral-200">{item.title}</div>
                <div className="shrink-0 text-xs text-neutral-500">{item.timingKind === "must" ? "Due" : "Target"} {formatDay(new Date(item.timingAt as string))}</div>
              </div>
            ))}
            {!upcoming.length && <div className="text-sm text-neutral-600">No dated work coming up.</div>}
          </div>
        </div>
      </section>

      <section className="lg:hidden">
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-600">Today / Next</div>
          <h2 className="mt-2 text-xl font-semibold">{formatDay(new Date(), true)}</h2>
          <div className="mt-4 space-y-2">
            {[...todayEvents.map((event) => ({ ...event, type: "event" as const })), ...todayBlocks.map((block) => ({ ...block, type: "block" as const }))]
              .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
              .map((entry) => entry.type === "block" ? (
                <button key={entry.id} onClick={() => setSelectedBlock(entry)} className="flex w-full items-center gap-3 rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-left">
                  <CircleDot size={16} className="text-amber-400" />
                  <div className="min-w-0 flex-1"><div className="truncate text-sm text-neutral-100">{entry.title}</div><div className="text-xs text-neutral-500">{formatTime(entry.start)}–{formatTime(entry.end)}</div></div>
                  <ChevronRight size={16} className="text-neutral-600" />
                </button>
              ) : (
                <div key={entry.id} className="flex items-center gap-3 rounded-xl border border-neutral-800 p-3">
                  <Clock3 size={16} className="text-neutral-600" /><div><div className="text-sm text-neutral-300">{entry.subject}</div><div className="text-xs text-neutral-600">{formatTime(entry.start)}–{formatTime(entry.end)}</div></div>
                </div>
              ))}
            {!todayEvents.length && !todayBlocks.length && <div className="rounded-xl border border-dashed border-neutral-800 p-5 text-center text-sm text-neutral-600">No protected work yet today.</div>}
          </div>
        </div>
        <ItemPicker items={openItems} selected={selectedItemIds} onChange={setSelectedItemIds} />
        <AttentionRail items={openItems} projects={initialDashboard.projects} />
      </section>

      <div className="hidden gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/60">
          <div className="grid grid-cols-7 border-b border-neutral-800 bg-neutral-950">
            {days.slice(0, 7).map((day) => <div key={dayKey(day)} className="border-r border-neutral-800 px-3 py-3 text-xs text-neutral-500 last:border-r-0">{formatDay(day)}</div>)}
          </div>
          {[days.slice(0, 7), days.slice(7, 14)].map((week, weekIndex) => (
            <div key={weekIndex} className="grid min-h-64 grid-cols-7 border-b border-neutral-800 last:border-b-0">
              {week.map((day) => {
                const events = initialDashboard.calendarEvents.filter((event) => dayKey(event.start) === dayKey(day));
                const blocks = initialDashboard.workBlocks.filter((block) => dayKey(block.start) === dayKey(day));
                return (
                  <div key={dayKey(day)} className={`min-w-0 border-r border-neutral-800 p-2 last:border-r-0 ${dayKey(day) === today ? "bg-amber-950/10" : ""}`}>
                    {weekIndex === 1 && <div className="mb-2 text-xs text-neutral-600">{formatDay(day)}</div>}
                    <div className="space-y-1.5">
                      {events.map((event) => <div key={event.id} className={`rounded-md border px-2 py-1.5 text-[11px] ${event.isTouchpoint ? "border-violet-800 bg-violet-950/30" : "border-neutral-800 bg-neutral-900/80"}`}><div className="truncate text-neutral-300">{event.subject}</div><div className="text-neutral-600">{formatTime(event.start)}</div></div>)}
                      {blocks.map((block) => <button key={block.id} onClick={() => setSelectedBlock(block)} className="w-full rounded-md border border-amber-800/70 bg-amber-950/30 px-2 py-1.5 text-left text-[11px] hover:border-amber-600"><div className="truncate text-amber-200">{block.title}</div><div className="text-amber-700">{formatTime(block.start)}–{formatTime(block.end)}</div></button>)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <ItemPicker items={openItems} selected={selectedItemIds} onChange={setSelectedItemIds} />
        </div>
        <AttentionRail items={openItems} projects={initialDashboard.projects} />
      </div>

      {selectedBlock && <BlockDrawer block={selectedBlock} saving={saving} onClose={() => setSelectedBlock(null)} onSave={(payload) => run(() => mutate(payload))} />}
    </div>
  );
}

function ProjectForm({ projects, saving, onSubmit }: { projects: Dashboard["availableMemoryProjects"]; saving: boolean; onSubmit: (payload: Record<string, unknown>) => void }) {
  return <form className="mb-4 grid gap-3 rounded-2xl border border-violet-900/50 bg-violet-950/10 p-4 sm:grid-cols-[220px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ action: "activate_project", memoryProjectEntityId: data.get("memoryProjectEntityId"), nextPlateau: data.get("nextPlateau") }); }}><select required name="memoryProjectEntityId" className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"><option value="">Choose Memory project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><input required name="nextPlateau" placeholder="What state should this reach next?" className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none" /><button disabled={saving} className="rounded-lg bg-violet-300 px-4 py-2 text-sm font-medium text-violet-950 disabled:opacity-50">Activate</button></form>;
}

function ItemForm({ projects, saving, onSubmit }: { projects: Dashboard["projects"]; saving: boolean; onSubmit: (payload: Record<string, unknown>) => void }) {
  return <form className="mb-4 grid gap-3 rounded-2xl border border-neutral-800 bg-neutral-950 p-4 sm:grid-cols-[1fr_180px_110px_auto]" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ action: "create_item", title: data.get("title"), projectStateId: data.get("projectStateId") || null, effortMinutes: data.get("effortMinutes") }); }}>
    <input required name="title" placeholder="Concrete work to move forward" className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600" />
    <select name="projectStateId" className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-400"><option value="">Loose work</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
    <input name="effortMinutes" type="number" min="1" max="1440" placeholder="Minutes" className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none" />
    <button disabled={saving} className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50">Save</button>
  </form>;
}

function BlockForm({ items, saving, onSubmit }: { items: Dashboard["items"]; saving: boolean; onSubmit: (payload: Record<string, unknown>) => void }) {
  return <form className="mb-4 grid gap-3 rounded-2xl border border-amber-900/50 bg-amber-950/10 p-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ action: "create_block", title: data.get("title"), start: data.get("start"), end: data.get("end"), itemIds: items.map((item) => item.id), checklist: items.map((item) => ({ id: item.id, label: item.title, checked: false })) }); }}>
    <div className="sm:col-span-2"><div className="text-xs uppercase tracking-wide text-amber-600">Protecting time for</div><div className="mt-1 text-sm text-neutral-300">{items.map((item) => item.title).join(" · ")}</div></div>
    <input required name="title" defaultValue={items.length > 1 ? "Admin sweep" : items[0]?.title ?? ""} className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none" />
    <div className="grid grid-cols-2 gap-2"><input required name="start" type="datetime-local" className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm" /><input required name="end" type="datetime-local" className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm" /></div>
    <button disabled={saving} className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-medium text-neutral-950 disabled:opacity-50 sm:col-span-2">Commit work block</button>
  </form>;
}

const TIER_STYLE: Record<string, string> = {
  P1: "border-red-800 bg-red-950/40 text-red-300",
  P2: "border-amber-800 bg-amber-950/30 text-amber-300",
  P3: "border-neutral-700 bg-neutral-900 text-neutral-400",
  background: "border-neutral-800 bg-neutral-950 text-neutral-600",
};

function PriorityBadge({ item }: { item: Dashboard["items"][number] }) {
  const router = useRouter();
  const directive = item.priorityDirective;
  const [busy, setBusy] = useState(false);

  async function act(body: Record<string, unknown>, event: React.MouseEvent) {
    event.stopPropagation();
    setBusy(true);
    try {
      await fetch("/api/execute/priority", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!directive) {
    return <div className="mt-1 text-[10px] text-neutral-700">Not yet prioritized</div>;
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TIER_STYLE[directive.tier] ?? TIER_STYLE.background}`}>{directive.tier}</span>
        <span className="text-[10px] text-neutral-600">{directive.protection} protection{directive.source === "manual" ? " · manual" : ""}</span>
      </div>
      {directive.why && <div className="mt-1 text-[11px] leading-4 text-neutral-500">{directive.why}</div>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        <button disabled={busy} onClick={(event) => act({ action: "set_tier", itemId: item.id, tier: "P1" }, event)} className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-900 disabled:opacity-40">Raise</button>
        <button disabled={busy} onClick={(event) => act({ action: "set_tier", itemId: item.id, tier: "P3" }, event)} className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-900 disabled:opacity-40">Lower</button>
        <button disabled={busy} onClick={(event) => act({ action: "mark_not_now", itemId: item.id }, event)} className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-900 disabled:opacity-40">Not now</button>
        <a href={`/inspector-general?objectType=execution_item&objectId=${item.id}`} onClick={(event) => event.stopPropagation()} className="rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-900">Why?</a>
      </div>
    </div>
  );
}

function ItemPicker({ items, selected, onChange }: { items: Dashboard["items"]; selected: string[]; onChange: (ids: string[]) => void }) {
  return <div className="border-t border-neutral-800 p-4"><div className="mb-3 flex items-center justify-between"><div className="text-xs font-medium uppercase tracking-[0.15em] text-neutral-600">My work</div><div className="text-xs text-neutral-700">{selected.length} selected</div></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => {
    const active = selected.includes(item.id); const coverage = item.effortMinutes ? Math.min(100, Math.round(item.allocatedMinutes / item.effortMinutes * 100)) : 0;
    return <button key={item.id} onClick={() => onChange(active ? selected.filter((id) => id !== item.id) : [...selected, item.id])} className={`rounded-xl border p-3 text-left transition ${active ? "border-amber-700 bg-amber-950/20" : "border-neutral-800 hover:border-neutral-700"}`}><div className="text-xs text-neutral-600">{item.projectName ?? "Loose work"}{item.criticalRank ? ` · Critical ${item.criticalRank}` : ""}</div><div className="mt-1 text-sm text-neutral-200">{item.title}</div>{item.effortMinutes && <div className="mt-2"><div className="h-1 overflow-hidden rounded bg-neutral-800"><div className="h-full bg-amber-500" style={{ width: `${coverage}%` }} /></div><div className="mt-1 text-[10px] text-neutral-600">{item.allocatedMinutes} / ~{item.effortMinutes} min protected</div></div>}<PriorityBadge item={item} /></button>;
  })}{!items.length && <div className="text-sm text-neutral-600">No active execution items yet.</div>}</div></div>;
}

function AttentionRail({ items, projects }: { items: Dashboard["items"]; projects: Dashboard["projects"] }) {
  // Scheduling-level nudges only (a project with no next plateau, an item
  // under-protected relative to its estimate) -- real reconciliation
  // judgments (candidates, proposals, ambiguous matches) live in the
  // "Needs review" ReconciliationReview panel above, not duplicated here.
  const rows = [
    ...projects.filter((project) => !project.nextPlateau).map((project) => ({ id: `project-${project.id}`, title: `${project.name} needs a next plateau.`, detail: null })),
    ...items.filter((item) => item.effortMinutes && item.allocatedMinutes < item.effortMinutes).slice(0, 4).map((item) => ({ id: `item-${item.id}`, title: `${item.title} needs protected time.`, detail: `${item.allocatedMinutes} of about ${item.effortMinutes} minutes accounted for.` })),
  ];
  return <aside className="mt-4 rounded-2xl border border-neutral-800 bg-neutral-950/70 p-4 lg:mt-0"><div className="flex items-center gap-2"><AlertTriangle size={15} className="text-amber-500" /><h2 className="text-sm font-medium">Scheduling gaps</h2></div><div className="mt-4 space-y-3">{rows.map((item) => <div key={item.id} className="rounded-xl border border-neutral-800 p-3"><div className="text-sm leading-5 text-neutral-300">{item.title}</div>{item.detail && <div className="mt-1 text-xs leading-5 text-neutral-600">{item.detail}</div>}</div>)}{!rows.length && <div className="text-sm leading-6 text-neutral-600">The current plan has no obvious gaps.</div>}</div></aside>;
}

function BlockDrawer({ block, saving, onClose, onSave }: { block: ExecuteWorkBlock; saving: boolean; onClose: () => void; onSave: (payload: Record<string, unknown>) => void }) {
  const [checklist, setChecklist] = useState(block.checklist);
  const [note, setNote] = useState(block.completionNote ?? "");
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="h-full w-full max-w-md overflow-y-auto border-l border-neutral-800 bg-neutral-950 p-5 shadow-2xl"><div className="flex items-start justify-between"><div><div className="text-xs uppercase tracking-wide text-amber-600">Work block</div><h2 className="mt-2 text-xl font-semibold">{block.title}</h2><div className="mt-1 text-sm text-neutral-500">{formatTime(block.start)}–{formatTime(block.end)}{block.calendarEventId ? " · synced with Outlook" : " · calendar handoff pending"}</div></div><button onClick={onClose} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-900"><X size={18} /></button></div><div className="mt-6 space-y-2">{checklist.map((item, index) => <label key={item.id} className="flex cursor-pointer gap-3 rounded-xl border border-neutral-800 p-3"><input type="checkbox" checked={item.checked} onChange={(event) => setChecklist((current) => current.map((entry, itemIndex) => itemIndex === index ? { ...entry, checked: event.target.checked } : entry))} className="mt-0.5 h-4 w-4 accent-amber-500" /><span className={item.checked ? "text-sm text-neutral-600 line-through" : "text-sm text-neutral-300"}>{item.label}</span></label>)}</div><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="Optional note for replanning…" className="mt-5 w-full resize-none rounded-xl border border-neutral-800 bg-neutral-950 p-3 text-sm outline-none focus:border-neutral-600" /><div className="mt-5 grid grid-cols-3 gap-2">{(["completed", "partial", "missed"] as const).map((outcome) => <button key={outcome} disabled={saving} onClick={() => onSave({ action: "record_block_outcome", workBlockId: block.id, outcome, completedItemIds: outcome === "partial" ? block.items.filter((_, index) => checklist[index]?.checked).map((item) => item.id) : [], checklist, note })} className={`rounded-lg border px-2 py-2 text-sm capitalize disabled:opacity-50 ${outcome === "completed" ? "border-emerald-900 text-emerald-400" : "border-neutral-800 text-neutral-400"}`}>{outcome === "completed" && <Check size={14} className="mr-1 inline" />}{outcome}</button>)}</div></div></div>;
}
