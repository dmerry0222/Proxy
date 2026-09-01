import Link from "next/link";

import {
  ArrowRight,
  BrainCircuit,
} from "lucide-react";

import {
  loadMemoryReviewItems,
} from "@/lib/memory/loadReviewItems";

/*
 * Must match /memory/review: this page renders the pending COUNT from the
 * same loader, so if one is static and the other dynamic the CTA and the
 * queue disagree. Both are per-request.
 */
export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const reviewItems =
    await loadMemoryReviewItems();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-10">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-neutral-600">
          <BrainCircuit
            size={15}
          />

          Proxy Memory
        </div>

        <h1 className="mt-3 text-2xl font-semibold text-neutral-100">
          What Proxy knows
        </h1>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
          Persistent context about people, projects, decisions,
          responsibilities, history, and things worth resurfacing later.
        </p>
      </div>

      <Link
        href="/memory/review"
        className="group flex items-center justify-between rounded-2xl border border-neutral-800 bg-neutral-950/60 p-5 transition hover:border-neutral-700 hover:bg-neutral-900/70"
      >
        <div>
          <div className="text-sm font-medium text-neutral-200">
            Memory Review
          </div>

          <div className="mt-1 text-sm text-neutral-500">
            {reviewItems.length === 0
              ? "Nothing needs your judgment right now."
              : `${reviewItems.length} ${
                  reviewItems.length === 1
                    ? "item"
                    : "items"
                } waiting for a quick decision.`}
          </div>
        </div>

        <ArrowRight
          size={18}
          className="text-neutral-600 transition group-hover:translate-x-0.5 group-hover:text-neutral-300"
        />
      </Link>
    </div>
  );
}