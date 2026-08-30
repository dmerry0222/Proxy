"use client";

import { useEffect, useState } from "react";
import { X, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle, Clock3 } from "lucide-react";

import type { DiagnosticEventRow, DiagnosticTraceRow } from "@/components/inspector-general/types";

function statusIcon(status: DiagnosticEventRow["status"]) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "warning":
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    case "failure":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "pending":
      return <Clock3 className="h-4 w-4 text-neutral-500" />;
  }
}

function EventRow({ event }: { event: DiagnosticEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  const hasDetail = Boolean(event.human_detail || event.decision_reason || event.technical_detail);

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((value) => !value)}
        className="flex w-full items-start gap-2 text-left"
      >
        {statusIcon(event.status)}

        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-600">
            <span>{event.stage}</span>
            {event.decision_type && (
              <span className="rounded border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 text-neutral-400">
                {event.decision_type}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-sm text-neutral-200">{event.human_summary}</div>
        </div>

        {hasDetail && (
          expanded ? <ChevronDown className="h-4 w-4 text-neutral-600" /> : <ChevronRight className="h-4 w-4 text-neutral-600" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-neutral-900 pt-3 pl-6 text-sm">
          {event.human_detail && <p className="text-neutral-400">{event.human_detail}</p>}
          {event.decision_reason && (
            <p className="text-neutral-400">
              <span className="text-neutral-600">Why: </span>
              {event.decision_reason}
            </p>
          )}

          {event.technical_detail && (
            <div>
              <button
                type="button"
                onClick={() => setShowTechnical((value) => !value)}
                className="text-xs text-neutral-600 underline decoration-dotted hover:text-neutral-400"
              >
                {showTechnical ? "Hide technical details" : "Show technical details"}
              </button>

              {showTechnical && (
                <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-black/40 p-2 text-xs text-neutral-500">
                  {[
                    event.technical_code,
                    event.technical_detail,
                    Object.keys(event.metadata ?? {}).length ? JSON.stringify(event.metadata, null, 2) : null,
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TraceDrawer({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<DiagnosticTraceRow | null>(null);
  const [events, setEvents] = useState<DiagnosticEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/inspector-general/trace/${traceId}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;

        if (!data.success) {
          setError(data.error ?? "Could not load trace.");
          return;
        }

        setTrace(data.result.trace);
        setEvents(data.result.events);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load trace.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [traceId]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-950 p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-600">Trace</div>
            <h2 className="mt-1 text-lg font-semibold text-neutral-100">{trace?.summary ?? "Loading…"}</h2>
            {trace && (
              <div className="mt-1 text-xs text-neutral-500">
                {trace.module} · started {new Date(trace.started_at).toLocaleString()}
              </div>
            )}
          </div>

          <button onClick={onClose} className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-900">
            <X size={18} />
          </button>
        </div>

        {loading && <div className="text-sm text-neutral-500">Loading trace…</div>}
        {error && <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</div>}

        {!loading && !error && events.length === 0 && (
          <div className="text-sm text-neutral-500">No events recorded for this trace.</div>
        )}

        <div className="space-y-2">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      </div>
    </div>
  );
}
