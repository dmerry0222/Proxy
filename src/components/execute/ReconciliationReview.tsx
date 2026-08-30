"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, HelpCircle, ShieldQuestion, X } from "lucide-react";

import type { EvidenceEntry, ReviewEntry } from "@/lib/execute/reviewTypes";

async function post(body: Record<string, unknown>) {
  const response = await fetch("/api/execute/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) throw new Error(payload.error ?? "That action could not be saved");
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-neutral-800 bg-neutral-950/70 p-3">{children}</div>;
}

function ActionButton({ label, primary = false, onClick, disabled }: { label: string; primary?: boolean; onClick: () => void; disabled: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
        primary ? "bg-amber-400 text-neutral-950" : "border border-neutral-800 text-neutral-300 hover:bg-neutral-900"
      }`}
    >
      {label}
    </button>
  );
}

function EvidenceDrilldown({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (evidence) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/execute/review/evidence?itemId=${itemId}`);
      const payload = await response.json();
      setEvidence(payload.result?.evidence ?? []);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      <button onClick={toggle} className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300">
        <HelpCircle size={12} /> Why does Proxy think this?
        <ChevronDown size={12} className={open ? "rotate-180 transition" : "transition"} />
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-l border-neutral-800 pl-3">
          {loading && <div className="text-xs text-neutral-600">Loading…</div>}
          {evidence?.length === 0 && <div className="text-xs text-neutral-600">No recorded evidence yet.</div>}
          {evidence?.map((entry) => (
            <div key={entry.id} className="text-xs">
              <div className="text-neutral-500">
                {entry.sourceType.replace(/_/g, " ")}
                {entry.occurredAt ? ` · ${formatDate(entry.occurredAt)}` : ""}
                {entry.personName ? ` · ${entry.personName}` : ""}
              </div>
              {entry.excerpt && <div className="mt-0.5 text-neutral-400">&ldquo;{entry.excerpt}&rdquo;</div>}
              <div className="mt-0.5 text-neutral-700">Supports: {entry.relationship.replace(/^supports_/, "").replace(/_/g, " ")}</div>
            </div>
          ))}
          <a href={`/inspector-general?objectType=execution_item&objectId=${itemId}`} className="inline-block text-neutral-600 underline hover:text-neutral-400">
            View full trace in Inspector General →
          </a>
        </div>
      )}
    </div>
  );
}

function CandidateCard({ entry, busy, act }: { entry: ReviewEntry; busy: boolean; act: (body: Record<string, unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [mergeTarget, setMergeTarget] = useState("");
  const isExternal = entry.type === "external_candidate";

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-neutral-100">
            {isExternal ? `Waiting on ${entry.item?.relatedPersonName ?? "someone"} — ${entry.item?.title}` : entry.item?.title}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500">
            {entry.item?.projectName && <span>{entry.item.projectName}</span>}
            {isExternal && entry.item?.expectedAt && <span>Expected {formatDate(entry.item.expectedAt)}</span>}
            {!isExternal && entry.item?.timingAt && <span>{entry.item.timingKind === "must" ? "Due" : "Target"} {formatDate(entry.item.timingAt)}</span>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {isExternal ? (
          <>
            <ActionButton label="Track waiting" primary disabled={busy} onClick={() => act({ action: "track_waiting", itemId: entry.executionItemId })} />
            <ActionButton label="Not relevant" disabled={busy} onClick={() => act({ action: "external_not_relevant", itemId: entry.executionItemId })} />
          </>
        ) : (
          <>
            <ActionButton label="Accept" primary disabled={busy} onClick={() => act({ action: "accept_candidate", itemId: entry.executionItemId })} />
            <ActionButton label="Already done" disabled={busy} onClick={() => act({ action: "mark_already_done", itemId: entry.executionItemId })} />
            <ActionButton label="Not mine" disabled={busy} onClick={() => act({ action: "reject_candidate", itemId: entry.executionItemId, reason: "not_mine" })} />
            <ActionButton label="Not a task" disabled={busy} onClick={() => act({ action: "reject_candidate", itemId: entry.executionItemId, reason: "not_a_task" })} />
          </>
        )}
        <button onClick={() => setEditing((value) => !value)} className="text-xs text-neutral-600 underline hover:text-neutral-400">
          {editing ? "Cancel edit" : "Merge / edit"}
        </button>
      </div>

      {editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-neutral-900 pt-3">
          <input
            value={mergeTarget}
            onChange={(event) => setMergeTarget(event.target.value)}
            placeholder="Existing item ID to merge into"
            className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs outline-none"
          />
          <ActionButton
            label="Merge"
            disabled={busy || !mergeTarget.trim()}
            onClick={() => act({ action: "merge_into", itemId: entry.executionItemId, targetItemId: mergeTarget.trim() })}
          />
        </div>
      )}

      {entry.executionItemId && <EvidenceDrilldown itemId={entry.executionItemId} />}
    </Card>
  );
}

function ProposalCard({ entry, busy, act }: { entry: ReviewEntry; busy: boolean; act: (body: Record<string, unknown>) => void }) {
  const isCompletion = entry.type === "completion_proposal";
  return (
    <Card>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-500/80">
        <ShieldQuestion size={13} />
        {isCompletion ? "Proxy thinks this may be complete" : "Proxy thinks this may no longer be needed"}
      </div>
      <div className="mt-2 text-sm text-neutral-100">{entry.item?.title ?? entry.title}</div>
      {entry.evidenceExcerpt && <div className="mt-1 text-xs text-neutral-500">&ldquo;{entry.evidenceExcerpt}&rdquo;</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        {isCompletion ? (
          <>
            <ActionButton label="Mark complete" primary disabled={busy} onClick={() => act({ action: "confirm_completion", attentionItemId: entry.attentionItemId })} />
            <ActionButton label="Still open" disabled={busy} onClick={() => act({ action: "reject_completion", attentionItemId: entry.attentionItemId })} />
          </>
        ) : (
          <>
            <ActionButton label="Cancel item" disabled={busy} onClick={() => act({ action: "confirm_cancellation", attentionItemId: entry.attentionItemId })} />
            <ActionButton label="Keep active" primary disabled={busy} onClick={() => act({ action: "reject_cancellation", attentionItemId: entry.attentionItemId })} />
            <ActionButton label="Defer" disabled={busy} onClick={() => act({ action: "defer_cancellation", attentionItemId: entry.attentionItemId })} />
          </>
        )}
      </div>
      {entry.executionItemId && <EvidenceDrilldown itemId={entry.executionItemId} />}
    </Card>
  );
}

function AmbiguousCard({ entry, busy, act }: { entry: ReviewEntry; busy: boolean; act: (body: Record<string, unknown>) => void }) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-violet-400/80">Proxy thinks these may describe the same work</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-600">New evidence</div>
          <div className="mt-1 text-sm text-neutral-200">{entry.proposedTitle}</div>
          {entry.evidenceExcerpt && <div className="mt-1 text-xs text-neutral-500">&ldquo;{entry.evidenceExcerpt}&rdquo;</div>}
        </div>
        <div className="rounded-lg border border-neutral-800 p-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-600">Possible existing item</div>
          <div className="mt-1 text-sm text-neutral-200">{entry.item?.title}</div>
          <div className="mt-1 text-xs text-neutral-500">{entry.item?.status} · {entry.item?.responsibility === "external" ? "external" : "mine"}{entry.item?.projectName ? ` · ${entry.item.projectName}` : ""}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton label="Same item" primary disabled={busy} onClick={() => act({ action: "resolve_ambiguous_same", attentionItemId: entry.attentionItemId })} />
        <ActionButton label="Different item" disabled={busy} onClick={() => act({ action: "resolve_ambiguous_different", attentionItemId: entry.attentionItemId })} />
        {entry.matchScore != null && <span className="text-[10px] text-neutral-700">match {Math.round(entry.matchScore * 100)}%</span>}
      </div>
      {entry.executionItemId && <EvidenceDrilldown itemId={entry.executionItemId} />}
    </Card>
  );
}

export default function ReconciliationReview({ entries }: { entries: ReviewEntry[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  async function act(entryId: string, body: Record<string, unknown>) {
    setBusyId(entryId);
    setError(null);
    try {
      await post(body);
      setDismissed((current) => new Set(current).add(entryId));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown error");
    } finally {
      setBusyId(null);
    }
  }

  const visible = entries.filter((entry) => !dismissed.has(entry.id));

  if (!visible.length) {
    return <div className="rounded-xl border border-dashed border-neutral-800 p-5 text-center text-sm text-neutral-600">Nothing needs review right now.</div>;
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
          <button onClick={() => setError(null)}><X size={13} /></button>
        </div>
      )}
      {visible.map((entry) => {
        const busy = busyId === entry.id;
        const wrappedAct = (body: Record<string, unknown>) => act(entry.id, body);
        if (entry.type === "dave_candidate" || entry.type === "external_candidate") {
          return <CandidateCard key={entry.id} entry={entry} busy={busy} act={wrappedAct} />;
        }
        if (entry.type === "completion_proposal" || entry.type === "cancellation_proposal") {
          return <ProposalCard key={entry.id} entry={entry} busy={busy} act={wrappedAct} />;
        }
        if (entry.type === "ambiguous_match") {
          return <AmbiguousCard key={entry.id} entry={entry} busy={busy} act={wrappedAct} />;
        }
        return (
          <Card key={entry.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-neutral-200">{entry.title}</div>
              <ActionButton label="Dismiss" disabled={busy} onClick={() => wrappedAct({ action: "dismiss_attention", attentionItemId: entry.attentionItemId })} />
            </div>
          </Card>
        );
      })}
      <div className="flex items-center gap-1 pt-1 text-[10px] text-neutral-700">
        <CheckCircle2 size={11} /> Every action here is recorded as a reconciliation decision.
      </div>
    </div>
  );
}
