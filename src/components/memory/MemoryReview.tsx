"use client";

import {
  useMemo,
  useState,
} from "react";

import {
  Check,
  CheckCircle2,
  Clock3,
  Database,
  Mail,
  Pencil,
  X,
} from "lucide-react";

import type {
  MemoryReviewItem,
} from "@/lib/memory/loadReviewItems";

type Props = {
  initialItems: MemoryReviewItem[];
};

type ReviewAction =
  | "confirm"
  | "outdated"
  | "keep_as_evidence"
  | "not_sure"
  | "follow_up"
  | "keep_waiting"
  | "resolved"
  | "dismiss";

type ReviewItemWithSource =
  MemoryReviewItem & {
    sourceSubject?: string | null;
    sourceDate?: string | null;
  };

function actionForOption(
  option: string
): ReviewAction | null {
  switch (
    option
      .trim()
      .toLowerCase()
  ) {
    case "confirm":
    case "confirm exact title":
      return "confirm";

    case "outdated":
      return "outdated";

    case "keep as evidence":
      return "keep_as_evidence";

    case "not sure":
      return "not_sure";

    case "follow up":
      return "follow_up";

    case "keep waiting":
      return "keep_waiting";

    case "resolved":
      return "resolved";

    case "dismiss":
      return "dismiss";

    default:
      return null;
  }
}

function optionLabel(
  option: string
) {
  switch (
    option
      .trim()
      .toLowerCase()
  ) {
    case "confirm":
    case "confirm exact title":
      return {
        title:
          "Confirm as memory",
        description:
          "Treat this as established context.",
      };

    case "outdated":
      return {
        title:
          "Outdated",
        description:
          "This used to be true, but is no longer current.",
      };

    case "keep as evidence":
      return {
        title:
          "Keep as supporting evidence",
        description:
          "Keep the observation, but don’t treat it as established truth yet.",
      };

    case "not sure":
      return {
        title:
          "Not sure yet",
        description:
          "Leave this unresolved for later review.",
      };

    case "follow up":
      return {
        title:
          "Follow up",
        description:
          "This still needs attention.",
      };

    case "keep waiting":
      return {
        title:
          "Keep waiting",
        description:
          "Still pending, but no action is needed yet.",
      };

    case "resolved":
      return {
        title:
          "Resolved",
        description:
          "This no longer needs to stay active.",
      };

    case "dismiss":
      return {
        title:
          "Dismiss",
        description:
          "This isn’t useful enough to keep resurfacing.",
      };

    default:
      return {
        title: option,
        description: null,
      };
  }
}

function optionIcon(
  action: ReviewAction | null
) {
  switch (action) {
    case "confirm":
    case "resolved":
      return <Check size={16} />;

    case "outdated":
    case "dismiss":
      return <X size={16} />;

    case "keep_as_evidence":
      return <Database size={16} />;

    case "not_sure":
    case "keep_waiting":
      return <Clock3 size={16} />;

    case "follow_up":
      return <CheckCircle2 size={16} />;

    default:
      return null;
  }
}

function formatSourceDate(
  value?: string | null
) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric",
    }
  );
}

function pendingLabel(
  item: MemoryReviewItem
) {
  if (
    item.reviewType !==
    "pending_context"
  ) {
    return null;
  }

  const options =
    item.options.map(
      (option) =>
        option
          .trim()
          .toLowerCase()
    );

  if (
    options.includes(
      "keep waiting"
    )
  ) {
    return "Waiting on";
  }

  if (
    options.includes(
      "follow up"
    )
  ) {
    return "Follow-up";
  }

  return "Pending";
}

export default function MemoryReview({
  initialItems,
}: Props) {
  const [items, setItems] =
    useState(initialItems);

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState<string | null>(
      null
    );

  const [
    correcting,
    setCorrecting,
  ] = useState(false);

  const [
    correctionText,
    setCorrectionText,
  ] = useState("");

  const currentItem =
    items[0] ?? null;

  const currentItemWithSource =
    currentItem as
      | ReviewItemWithSource
      | null;

  const remaining =
    items.length;

  const progressText =
    useMemo(() => {
      if (
        remaining === 0
      ) {
        return "Review complete";
      }

      if (
        remaining === 1
      ) {
        return "1 item";
      }

      return `${remaining} items`;
    }, [remaining]);

  const sourceDate =
    formatSourceDate(
      currentItemWithSource
        ?.sourceDate
    );

  const itemKind =
    currentItem
      ? pendingLabel(
          currentItem
        )
      : null;

  function advance() {
    setItems(
      (current) =>
        current.slice(1)
    );

    setCorrecting(false);
    setCorrectionText("");
  }

  async function resolveItem(
    option: string
  ) {
    if (
      !currentItem ||
      saving
    ) {
      return;
    }

    const action =
      actionForOption(
        option
      );

    if (!action) {
      setError(
        `Unsupported review option: ${option}`
      );

      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response =
        await fetch(
          "/api/memory/review",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                reviewItemId:
                  currentItem.id,

                action,
              }),
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ??
            "Could not save Memory review"
        );
      }

      advance();
    } catch (
      reviewError
    ) {
      setError(
        reviewError instanceof
          Error
          ? reviewError.message
          : "Unknown Memory review error"
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveCorrection() {
    if (
      !currentItem ||
      saving
    ) {
      return;
    }

    const correctedStatement =
      correctionText.trim();

    if (
      !correctedStatement
    ) {
      setError(
        "Tell Proxy what the current truth should be."
      );

      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response =
        await fetch(
          "/api/memory/review",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                reviewItemId:
                  currentItem.id,

                action:
                  "correction",

                correctedStatement,
              }),
          }
        );

      const result =
        await response.json();

      if (
        !response.ok ||
        !result.success
      ) {
        throw new Error(
          result.error ??
            "Could not save Memory correction"
        );
      }

      advance();
    } catch (
      reviewError
    ) {
      setError(
        reviewError instanceof
          Error
          ? reviewError.message
          : "Unknown Memory correction error"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 flex items-start justify-between gap-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-600">
            Memory
          </p>

          <h1 className="mt-2 text-2xl font-semibold text-neutral-100">
            Review
          </h1>

          <p className="mt-2 max-w-xl text-sm leading-6 text-neutral-500">
            A quick pass through things Proxy is unsure about,
            waiting on, or considering worth remembering.
          </p>
        </div>

        <div className="shrink-0 rounded-full border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-500">
          {progressText}
        </div>
      </div>

      {!currentItem ? (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-950/60 p-8 text-center">
          <CheckCircle2
            className="mx-auto h-8 w-8 text-neutral-600"
            strokeWidth={1.5}
          />

          <h2 className="mt-4 text-base font-medium text-neutral-200">
            You&apos;re caught up.
          </h2>

          <p className="mt-2 text-sm text-neutral-500">
            Proxy doesn&apos;t have anything that needs your judgment right now.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950/70">
          <div className="border-b border-neutral-800 px-6 py-5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-xs uppercase tracking-[0.15em] text-neutral-600">
                  {currentItem.entityName ??
                    "Memory"}
                </div>

                {itemKind && (
                  <>
                    <span className="text-neutral-800">
                      ·
                    </span>

                    <div className="text-xs font-medium text-neutral-500">
                      {itemKind}
                    </div>
                  </>
                )}
              </div>

              <div className="text-xs text-neutral-700">
                Priority{" "}
                {currentItem.priority}
              </div>
            </div>

            <h2 className="mt-3 text-lg font-medium text-neutral-100">
              {currentItem.title}
            </h2>

            {currentItem.prompt && (
              <p className="mt-3 text-sm leading-6 text-neutral-400">
                {currentItem.prompt}
              </p>
            )}

            {(currentItemWithSource
              ?.sourceSubject ||
              sourceDate) && (
              <div className="mt-4 flex items-start gap-2 border-t border-neutral-900 pt-3 text-xs leading-5 text-neutral-600">
                <Mail
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  strokeWidth={1.6}
                />

                <div className="min-w-0">
                  <span>
                    From:
                  </span>{" "}

                  {currentItemWithSource
                    ?.sourceSubject && (
                    <span className="text-neutral-500">
                      {
                        currentItemWithSource
                          .sourceSubject
                      }
                    </span>
                  )}

                  {currentItemWithSource
                    ?.sourceSubject &&
                    sourceDate && (
                      <span>
                        {" "}
                        ·{" "}
                      </span>
                    )}

                  {sourceDate && (
                    <span>
                      {sourceDate}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {!correcting ? (
            <div className="space-y-2 p-4">
              {currentItem.options.map(
                (
                  option
                ) => {
                  const action =
                    actionForOption(
                      option
                    );

                  const label =
                    optionLabel(
                      option
                    );

                  return (
                    <button
                      key={
                        option
                      }
                      type="button"
                      disabled={
                        saving
                      }
                      onClick={() =>
                        resolveItem(
                          option
                        )
                      }
                      className="flex w-full items-start gap-3 rounded-xl border border-neutral-800 px-4 py-3 text-left transition hover:border-neutral-700 hover:bg-neutral-900 disabled:cursor-wait disabled:opacity-50"
                    >
                      <span className="mt-0.5 text-neutral-500">
                        {optionIcon(
                          action
                        )}
                      </span>

                      <span className="min-w-0">
                        <span className="block text-sm text-neutral-300 transition group-hover:text-neutral-100">
                          {
                            label.title
                          }
                        </span>

                        {label.description && (
                          <span className="mt-0.5 block text-xs leading-5 text-neutral-600">
                            {
                              label.description
                            }
                          </span>
                        )}
                      </span>
                    </button>
                  );
                }
              )}

              {currentItem.reviewType !==
                "pending_context" && (
                <button
                  type="button"
                  disabled={
                    saving
                  }
                  onClick={() => {
                    setCorrecting(
                      true
                    );

                    setError(
                      null
                    );
                  }}
                  className="flex w-full items-start gap-3 rounded-xl border border-neutral-800 px-4 py-3 text-left transition hover:border-neutral-700 hover:bg-neutral-900 disabled:opacity-50"
                >
                  <span className="mt-0.5 text-neutral-500">
                    <Pencil
                      size={
                        16
                      }
                    />
                  </span>

                  <span>
                    <span className="block text-sm text-neutral-300">
                      Actually…
                    </span>

                    <span className="mt-0.5 block text-xs leading-5 text-neutral-600">
                      There&apos;s a real memory here, but Proxy has it wrong or too broad.
                    </span>
                  </span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3 p-4">
              <div>
                <label
                  htmlFor="memory-correction"
                  className="text-xs font-medium uppercase tracking-[0.14em] text-neutral-600"
                >
                  What should Proxy remember instead?
                </label>

                <textarea
                  id="memory-correction"
                  value={
                    correctionText
                  }
                  onChange={(
                    event
                  ) =>
                    setCorrectionText(
                      event
                        .target
                        .value
                    )
                  }
                  autoFocus
                  rows={4}
                  placeholder="Describe the current truth in your own words…"
                  className="mt-3 w-full resize-none rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm leading-6 text-neutral-200 outline-none transition placeholder:text-neutral-700 focus:border-neutral-600"
                />
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={
                    saving ||
                    !correctionText.trim()
                  }
                  onClick={
                    saveCorrection
                  }
                  className="flex-1 rounded-xl border border-neutral-700 bg-neutral-100 px-4 py-3 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving
                    ? "Saving…"
                    : "Remember this"}
                </button>

                <button
                  type="button"
                  disabled={
                    saving
                  }
                  onClick={() => {
                    setCorrecting(
                      false
                    );

                    setCorrectionText(
                      ""
                    );

                    setError(
                      null
                    );
                  }}
                  className="rounded-xl border border-neutral-800 px-4 py-3 text-sm text-neutral-400 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-red-950 bg-red-950/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}