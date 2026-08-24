"use client";

import {
  useMemo,
  useState,
} from "react";

import {
  Archive,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Inbox,
  Mail,
  Newspaper,
  Sparkles,
  SquareCheckBig,
} from "lucide-react";

import type {
  MailroomBucket,
} from "@/lib/mailroom/types";

import type {
  MailroomReviewConversation,
} from "@/lib/mailroom/loadLatestMailroomRun";

type Props = {
  initialConversations:
    MailroomReviewConversation[];

  runId:
    string | null;
};

const BUCKET_ORDER:
  MailroomBucket[] =
    [
      "Needs You",
      "FYI",
      "Professional News",
      "Low Value",
    ];

function bucketStyles(
  bucket: MailroomBucket
) {
  switch (bucket) {
    case "Needs You":
      return "text-red-300 bg-red-950/40 border-red-900/50";

    case "FYI":
      return "text-blue-300 bg-blue-950/30 border-blue-900/50";

    case "Professional News":
      return "text-violet-300 bg-violet-950/30 border-violet-900/50";

    case "Low Value":
      return "text-neutral-400 bg-neutral-900 border-neutral-800";
  }
}

function BucketIcon({
  bucket,
}: {
  bucket:
    MailroomBucket;
}) {
  switch (bucket) {
    case "Needs You":
      return (
        <CircleAlert className="h-4 w-4" />
      );

    case "FYI":
      return (
        <Mail className="h-4 w-4" />
      );

    case "Professional News":
      return (
        <Newspaper className="h-4 w-4" />
      );

    case "Low Value":
      return (
        <Archive className="h-4 w-4" />
      );
  }
}

function defaultActionsForBucket(
  bucket: MailroomBucket
) {
  const needsAction =
    bucket ===
    "Needs You";

  return {
    needsAction,

    archive:
      !needsAction,
  };
}

function formatDate(
  value: string | null
) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      month:
        "short",

      day:
        "numeric",

      hour:
        "numeric",

      minute:
        "2-digit",
    }
  ).format(
    new Date(
      value
    )
  );
}

export default function MailroomReview({
  initialConversations,
  runId,
}: Props) {
  const [
    conversations,
    setConversations,
  ] =
    useState<
      MailroomReviewConversation[]
    >(
      initialConversations
    );

  const [
    expanded,
    setExpanded,
  ] =
    useState<
      Record<
        string,
        boolean
      >
    >({});

  const [
    calendarExpanded,
    setCalendarExpanded,
  ] =
    useState(
      false
    );

  const [
    collapsedBuckets,
    setCollapsedBuckets,
  ] =
    useState<
      Partial<
        Record<
          MailroomBucket,
          boolean
        >
      >
    >({});

  const [
    reviewComplete,
    setReviewComplete,
  ] =
    useState(
      false
    );

  const [
    saving,
    setSaving,
  ] =
    useState(
      false
    );

  const [
    analyzing,
    setAnalyzing,
  ] =
    useState(
      false
    );

  const [
    executing,
    setExecuting,
  ] =
    useState(
      false
    );

  const [
    saveError,
    setSaveError,
  ] =
    useState<
      string | null
    >(null);

  /*
   * Tracks previously reviewed Inbox items that Dave edits
   * after their initial Mailroom review.
   *
   * Pending-review items are always saved by Go For It.
   * Older reviewed items are saved only when they become dirty.
   */
  const [
    dirtyConversationIds,
    setDirtyConversationIds,
  ] =
    useState<
      Record<
        string,
        boolean
      >
    >({});

  const workdayItems =
    conversations.filter(
      (
        conversation
      ) =>
        conversation.systemType ===
        "workday"
    );

  const calendarResponses =
    conversations.filter(
      (
        conversation
      ) =>
        conversation.systemType ===
        "calendar_response"
    );

  const meetingRequests =
    conversations.filter(
      (
        conversation
      ) =>
        conversation.systemType ===
        "meeting_request"
    );

  const normalConversations =
    conversations.filter(
      (
        conversation
      ) =>
        !conversation.systemType
    );

  /*
   * Conversations belonging to the current AI run are always
   * part of the next Go For It save.
   */
  const pendingConversations =
    conversations.filter(
      (
        conversation
      ) =>
        conversation.isPendingReview
    );

  /*
   * Previously reviewed Inbox items remain fully editable.
   * Only ones Dave actually changes are included in the save.
   */
  const dirtyConversations =
    conversations.filter(
      (
        conversation
      ) =>
        dirtyConversationIds[
          conversation.conversationId
        ] ===
        true
    );

  const conversationsToSave =
    conversations.filter(
      (
        conversation
      ) =>
        conversation.isPendingReview ||
        dirtyConversationIds[
          conversation.conversationId
        ] ===
          true
    );

  const unsavedReviewedChanges =
    dirtyConversations.filter(
      (
        conversation
      ) =>
        !conversation.isPendingReview
    ).length;

  const grouped =
    useMemo(
      () =>
        BUCKET_ORDER.map(
          (
            bucket
          ) => ({
            bucket,

            conversations:
              normalConversations.filter(
                (
                  conversation
                ) =>
                  conversation.bucket ===
                  bucket
              ),
          })
        ),

      [
        normalConversations,
      ]
    );

  function updateConversation(
    conversationId:
      string,

    updates:
      Partial<MailroomReviewConversation>
  ) {
    setConversations(
      (
        current
      ) =>
        current.map(
          (
            conversation
          ) =>
            conversation.conversationId ===
            conversationId
              ? {
                  ...conversation,
                  ...updates,
                }
              : conversation
        )
    );

    setDirtyConversationIds(
      (
        current
      ) => ({
        ...current,

        [conversationId]:
          true,
      })
    );

    setReviewComplete(
      false
    );
  }

  function changeBucket(
    conversationId:
      string,

    bucket:
      MailroomBucket
  ) {
    const defaults =
      defaultActionsForBucket(
        bucket
      );

    updateConversation(
      conversationId,
      {
        bucket,

        needsAction:
          defaults.needsAction,

        archive:
          defaults.archive,
      }
    );
  }

  function changeNeedsAction(
    conversationId:
      string,

    checked:
      boolean
  ) {
    updateConversation(
      conversationId,
      {
        needsAction:
          checked,

        /*
         * Only force Archive off
         * when Needs Action is
         * actively checked.
         *
         * If Needs Action is
         * unchecked, both may
         * remain false.
         */
        ...(checked
          ? {
              archive:
                false,
            }
          : {}),
      }
    );
  }

  function changeArchive(
    conversationId:
      string,

    checked:
      boolean
  ) {
    updateConversation(
      conversationId,
      {
        archive:
          checked,

        /*
         * Only force Needs Action
         * off when Archive is
         * actively checked.
         */
        ...(checked
          ? {
              needsAction:
                false,
            }
          : {}),
      }
    );
  }

  function toggleExpanded(
    conversationId:
      string
  ) {
    setExpanded(
      (
        current
      ) => ({
        ...current,

        [conversationId]:
          !current[
            conversationId
          ],
      })
    );
  }

  function toggleBucket(
    bucket:
      MailroomBucket
  ) {
    setCollapsedBuckets(
      (
        current
      ) => ({
        ...current,

        [bucket]:
          !current[
            bucket
          ],
      })
    );
  }

  const needsActionCount =
    conversationsToSave.filter(
      (
        conversation
      ) =>
        !conversation.systemType &&
        conversation.needsAction
    ).length;

  const archiveCount =
    conversationsToSave.filter(
      (
        conversation
      ) =>
        !conversation.systemType &&
        conversation.archive
    ).length;

  function wait(
    milliseconds: number
  ) {
    return new Promise<void>(
      (resolve) =>
        setTimeout(
          resolve,
          milliseconds
        )
    );
  }

  async function waitForExecution(
    targetRunId: string
  ) {
    const MAX_ATTEMPTS =
      45;

    const POLL_INTERVAL_MS =
      2000;

    for (
      let attempt = 0;
      attempt <
      MAX_ATTEMPTS;
      attempt += 1
    ) {
      const response =
        await fetch(
          `/api/mailroom/run-status?runId=${encodeURIComponent(
            targetRunId
          )}`,
          {
            cache:
              "no-store",
          }
        );

      const result =
        await response.json();

      if (!response.ok) {
        throw new Error(
          result.error ||
            "Could not check Mailroom execution status"
        );
      }

      if (
        result.status ===
        "completed"
      ) {
        return;
      }

      if (
        result.status ===
        "failed"
      ) {
        throw new Error(
          result.error ||
            "Power Automate could not complete this Mailroom run."
        );
      }

      await wait(
        POLL_INTERVAL_MS
      );
    }

    throw new Error(
      "Outlook is taking longer than expected to finish. Your review was saved, but the Inbox refresh has not completed yet."
    );
  }

  async function analyzeNextBatch() {
    setAnalyzing(
      true
    );

    setSaveError(
      null
    );

    try {
      const response =
        await fetch(
          "/api/mailroom/run",
          {
            method:
              "GET",

            cache:
              "no-store",
          }
        );

      const result =
        await response.json();

      if (
        !response.ok
      ) {
        throw new Error(
          result.error ||
            "Could not analyze the next Mailroom batch"
        );
      }

      window.location.reload();
    } catch (
      error
    ) {
      setSaveError(
        error instanceof
        Error
          ? error.message
          : "Could not analyze the next Mailroom batch"
      );

      setAnalyzing(
        false
      );
    }
  }

  async function approveReview() {
    if (
      conversationsToSave.length ===
      0
    ) {
      setSaveError(
        "There are no new reviews or unsaved Mailroom changes."
      );

      return;
    }

    setSaving(
      true
    );

    setSaveError(
      null
    );

    try {
      const reviewResponse =
        await fetch(
          "/api/mailroom/review",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                runId,

                conversations:
                  conversationsToSave.map(
                    (
                      conversation
                    ) => ({
                      conversationId:
                        conversation.conversationId,

                      mailroomConversationId:
                        conversation.mailroomConversationId,

                      isPendingReview:
                        conversation.isPendingReview,

                      latestMessageId:
                        conversation.latestMessageId,

                      inboxMessageIds:
                        conversation.inboxMessageIds,

                      systemType:
                        conversation.systemType ??
                        null,

                      bucket:
                        conversation.bucket,

                      originalBucket:
                        conversation.originalBucket,

                      needsAction:
                        conversation.needsAction,

                      originalNeedsAction:
                        conversation.originalNeedsAction,

                      archive:
                        conversation.archive,

                      originalArchive:
                        conversation.originalArchive,

                      feedback:
                        conversation.feedback,
                    })
                  ),
              }),
          }
        );

      const reviewResult =
        await reviewResponse.json();

      if (
        !reviewResponse.ok
      ) {
        throw new Error(
          reviewResult.error ||
            "Could not save Mailroom review"
        );
      }

      const executionResponse =
        await fetch(
          "/api/mailroom/send-execution",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                runId:
                  reviewResult.runId,
              }),
          }
        );

      const executionResult =
        await executionResponse.json();

      if (
        !executionResponse.ok
      ) {
        throw new Error(
          executionResult.error ||
            "Review saved, but execution email could not be sent"
        );
      }

      /*
       * The review has been persisted and the execution email
       * has been handed off to Power Automate.
       *
       * Power Automate now:
       * 1. executes the Outlook actions
       * 2. refreshes Inbox into Supabase
       * 3. finalizes the Inbox snapshot
       * 4. marks this Mailroom run completed
       *
       * Keep the user on a Working on it screen until that
       * handshake is complete.
       */
      setReviewComplete(
        true
      );

      setExecuting(
        true
      );

      const executionRunId =
        reviewResult.runId as string;

      await waitForExecution(
        executionRunId
      );

      /*
       * Supabase now reflects the updated Outlook Inbox.
       * Analyze only genuinely-new/unprocessed mail.
       */
      setAnalyzing(
        true
      );

      const nextBatchResponse =
        await fetch(
          "/api/mailroom/run",
          {
            method:
              "GET",

            cache:
              "no-store",
          }
        );

      const nextBatchResult =
        await nextBatchResponse.json();

      if (
        !nextBatchResponse.ok
      ) {
        throw new Error(
          nextBatchResult.error ||
            "Outlook was updated, but the next Mailroom batch could not be analyzed."
        );
      }

      window.location.reload();
    } catch (
      error
    ) {
      setSaveError(
        error instanceof
        Error
          ? error.message
          : "Could not complete Mailroom review"
      );
    } finally {
      setSaving(
        false
      );

      setAnalyzing(
        false
      );

      setExecuting(
        false
      );
    }
  }

  return (
    <div className="space-y-6">
      {executing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/90 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-8 text-center shadow-2xl">
            <Sparkles className="mx-auto h-7 w-7 animate-pulse text-blue-400" />

            <h2 className="mt-4 text-lg font-semibold text-neutral-100">
              Working on it…
            </h2>

            <p className="mt-2 text-sm leading-6 text-neutral-400">
              Proxy is updating Outlook and reconciling your inbox.
            </p>

            <p className="mt-3 text-xs leading-5 text-neutral-600">
              This screen will refresh automatically when Power Automate is finished.
            </p>
          </div>
        </div>
      )}

      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Inbox className="h-4 w-4" />
            Mailroom
          </div>

          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Inbox review
          </h1>

          <p className="mt-1 text-sm text-neutral-400">
            {
              conversations.length
            }{" "}
            currently in inbox
            {" · "}
            {
              pendingConversations.length
            }{" "}
            awaiting approval
            {unsavedReviewedChanges >
              0 && (
              <>
                {" · "}
                {
                  unsavedReviewedChanges
                }{" "}
                unsaved reviewed change
                {unsavedReviewedChanges ===
                1
                  ? ""
                  : "s"}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="text-xs text-neutral-500">
            {runId
              ? "AI analysis ready for review"
              : "No new analyzed batch waiting"}
          </div>

          <button
            type="button"
            onClick={
              analyzeNextBatch
            }
            disabled={
              analyzing ||
              saving ||
              executing
            }
            className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-200 transition hover:border-neutral-600 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />

            {analyzing
              ? "Analyzing..."
              : "Analyze next batch"}
          </button>
        </div>
      </header>

      {(
        workdayItems.length >
          0 ||
        calendarResponses.length >
          0 ||
        meetingRequests.length >
          0
      ) && (
        <section className="space-y-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-neutral-600">
            Systems
          </div>

          {workdayItems.length >
            0 && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40">
              <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-900/50 bg-cyan-950/30 text-cyan-300">
                    <BriefcaseBusiness className="h-4 w-4" />
                  </div>

                  <div>
                    <div className="text-sm font-medium text-neutral-200">
                      Workday
                    </div>

                    <div className="mt-1 text-xs text-neutral-500">
                      {
                        workdayItems.length
                      }{" "}
                      notification
                      {workdayItems.length ===
                      1
                        ? ""
                        : "s"}{" "}
                      requiring review
                    </div>
                  </div>
                </div>

                <a
                  href="https://www.myworkday.com/suffolk/d/home.htmld"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-sm text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900"
                >
                  Open Workday

                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          )}

          {(
            calendarResponses.length >
              0 ||
            meetingRequests.length >
              0
          ) && (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/40">
              <div className="p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-blue-900/50 bg-blue-950/30 text-blue-300">
                      <CalendarDays className="h-4 w-4" />
                    </div>

                    <div>
                      <div className="text-sm font-medium text-neutral-200">
                        Calendar
                      </div>

                      <div className="mt-1 text-xs text-neutral-500">
                        {
                          calendarResponses.length
                        }{" "}
                        response
                        {calendarResponses.length ===
                        1
                          ? ""
                          : "s"}

                        {" · "}

                        {
                          meetingRequests.length
                        }{" "}
                        meeting request
                        {meetingRequests.length ===
                        1
                          ? ""
                          : "s"}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setCalendarExpanded(
                        (
                          current
                        ) =>
                          !current
                      )
                    }
                    className="flex items-center gap-2 text-sm text-neutral-400 transition hover:text-neutral-200"
                  >
                    {calendarExpanded
                      ? "Hide activity"
                      : "Review activity"}

                    {calendarExpanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                </div>

                {calendarExpanded && (
                  <div className="mt-4 space-y-5 border-t border-neutral-800 pt-4">
                    {calendarResponses.length >
                      0 && (
                      <div>
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-600">
                          Meeting responses
                        </div>

                        <div className="space-y-1">
                          {calendarResponses.map(
                            (
                              conversation
                            ) => (
                              <div
                                key={
                                  conversation.conversationId
                                }
                                className="flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm sm:flex-row sm:items-center sm:justify-between"
                              >
                                <span className="text-neutral-300">
                                  {
                                    conversation.subject
                                  }
                                </span>

                                <span className="text-xs text-neutral-500">
                                  {
                                    conversation.summary
                                  }
                                </span>
                              </div>
                            )
                          )}
                        </div>

                        <div className="mt-2 text-xs text-neutral-600">
                          These notification emails will be archived automatically.
                        </div>
                      </div>
                    )}

                    {meetingRequests.length >
                      0 && (
                      <div className="border-t border-neutral-800 pt-4">
                        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-600">
                          Meeting requests
                        </div>

                        <div className="space-y-2">
                          {meetingRequests.map(
                            (
                              conversation
                            ) => (
                              <div
                                key={
                                  conversation.conversationId
                                }
                                className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3 md:flex-row md:items-center md:justify-between"
                              >
                                <div>
                                  <div className="text-sm font-medium text-neutral-200">
                                    {
                                      conversation.subject
                                    }
                                  </div>

                                  <div className="mt-1 text-xs text-neutral-500">
                                    {conversation.senderName ||
                                      conversation.senderEmail ||
                                      "Unknown sender"}
                                  </div>
                                </div>

                                <div className="text-xs text-neutral-500">
                                  Handle manually in Outlook
                                </div>
                              </div>
                            )
                          )}
                        </div>

                        <div className="mt-2 text-xs text-neutral-600">
                          Proxy currently leaves meeting invitations untouched.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      <div className="space-y-6">
        {grouped.map(
          ({
            bucket,
            conversations:
              items,
          }) => {
            if (
              items.length ===
              0
            ) {
              return null;
            }

            const collapsed =
              collapsedBuckets[
                bucket
              ];

            return (
              <section
                key={
                  bucket
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    toggleBucket(
                      bucket
                    )
                  }
                  className="mb-2 flex w-full items-center gap-3 text-left"
                >
                  <div
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-lg border",
                      bucketStyles(
                        bucket
                      ),
                    ].join(
                      " "
                    )}
                  >
                    <BucketIcon
                      bucket={
                        bucket
                      }
                    />
                  </div>

                  <div className="flex flex-1 items-center gap-2">
                    <h2 className="text-sm font-semibold text-neutral-200">
                      {
                        bucket
                      }
                    </h2>

                    <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-neutral-500">
                      {
                        items.length
                      }
                    </span>
                  </div>

                  {collapsed ? (
                    <ChevronRight className="h-4 w-4 text-neutral-600" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-neutral-600" />
                  )}
                </button>

                {!collapsed && (
                  <div className="space-y-1.5">
                    {items.map(
                      (
                        conversation
                      ) => {
                        const isExpanded =
                          expanded[
                            conversation.conversationId
                          ];

                        return (
                          <article
                            key={
                              conversation.conversationId
                            }
                            className={[
                              "rounded-lg border border-neutral-800 bg-neutral-900/35 transition hover:border-neutral-700 hover:bg-neutral-900/55",

                              !conversation.isPendingReview &&
                              conversation.hasStoredAnalysis
                                ? "border-l-2 border-l-neutral-600"
                                : "",
                            ].join(
                              " "
                            )}
                          >
                            <div className="p-3">
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    toggleExpanded(
                                      conversation.conversationId
                                    )
                                  }
                                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-800 hover:text-neutral-300"
                                >
                                  {isExpanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </button>

                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-col gap-1 lg:flex-row lg:items-start lg:justify-between">
                                    <div className="min-w-0">
                                      <h3 className="truncate text-sm font-medium text-neutral-100">
                                        {
                                          conversation.subject
                                        }
                                      </h3>

                                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-500">
                                        <span>
                                          {conversation.senderName ||
                                            conversation.senderEmail ||
                                            "Unknown sender"}
                                        </span>

                                        {conversation.latestMessageAt && (
                                          <>
                                            <span>
                                              ·
                                            </span>

                                            <span>
                                              {formatDate(
                                                conversation.latestMessageAt
                                              )}
                                            </span>
                                          </>
                                        )}

                                        {conversation.messages.length >
                                          1 && (
                                          <>
                                            <span>
                                              ·
                                            </span>

                                            <span>
                                              {
                                                conversation.messages.length
                                              }{" "}
                                              messages
                                            </span>
                                          </>
                                        )}
                                      </div>
                                    </div>

                                    {conversation.inboxMessageIds.length >
                                      1 && (
                                      <span className="shrink-0 text-xs text-neutral-600">
                                        {
                                          conversation.inboxMessageIds.length
                                        }{" "}
                                        in inbox
                                      </span>
                                    )}

                                  </div>

                                  <p className="mt-2 line-clamp-2 text-sm leading-5 text-neutral-400">
                                    {
                                      conversation.summary
                                    }
                                  </p>

                                  {conversation.suggestedReply && (
                                    <div className="mt-3 rounded-lg border border-blue-900/40 bg-blue-950/20 p-3">
                                      <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                          <div className="text-xs font-medium uppercase tracking-wide text-blue-400/70">
                                            Suggested reply
                                          </div>

                                          <p className="mt-1 text-sm leading-6 text-neutral-300">
                                            {
                                              conversation.suggestedReply
                                            }
                                          </p>
                                        </div>

                                        <button
                                          type="button"
                                          onClick={() =>
                                            navigator.clipboard.writeText(
                                              conversation.suggestedReply ??
                                                ""
                                            )
                                          }
                                          className="flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-400 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-200"
                                        >
                                          <Copy className="h-3.5 w-3.5" />
                                          Copy
                                        </button>
                                      </div>
                                    </div>
                                  )}

                                  {isExpanded && (
                                    <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/60">
                                      <div className="border-b border-neutral-800 px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-600">
                                        Thread ·{" "}
                                        {
                                          conversation.messages.length
                                        }{" "}
                                        {conversation.messages.length ===
                                        1
                                          ? "message"
                                          : "messages"}
                                      </div>

                                      <div className="divide-y divide-neutral-800">
                                        {conversation.messages.map(
                                          (
                                            message
                                          ) => (
                                            <div
                                              key={
                                                message.outlookMessageId
                                              }
                                              className="p-3"
                                            >
                                              <div className="flex flex-wrap items-center gap-x-2 text-xs">
                                                <span className="font-medium text-neutral-300">
                                                  {message.direction.toLowerCase() ===
                                                  "outgoing"
                                                    ? "You"
                                                    : message.fromName ||
                                                      message.fromEmail ||
                                                      "Unknown sender"}
                                                </span>

                                                {message.messageAt && (
                                                  <>
                                                    <span className="text-neutral-700">
                                                      ·
                                                    </span>

                                                    <span className="text-neutral-600">
                                                      {formatDate(
                                                        message.messageAt
                                                      )}
                                                    </span>
                                                  </>
                                                )}

                                                {message.folder !==
                                                  "Inbox" && (
                                                  <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] uppercase text-neutral-600">
                                                    {
                                                      message.folder
                                                    }
                                                  </span>
                                                )}
                                              </div>

                                              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-400">
                                                {message.bodyPreview ||
                                                  "No preview available."}
                                              </p>
                                            </div>
                                          )
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  <div className="mt-3 grid gap-2 xl:grid-cols-[170px_auto_auto_minmax(240px,1fr)] xl:items-center">
                                    <select
                                      value={
                                        conversation.bucket
                                      }
                                      disabled={
                                        saving ||
                                        analyzing ||
                                        executing
                                      }
                                      onChange={(
                                        event
                                      ) =>
                                        changeBucket(
                                          conversation.conversationId,
                                          event.target.value as MailroomBucket
                                        )
                                      }
                                      className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-300 outline-none focus:border-neutral-600"
                                    >
                                      {BUCKET_ORDER.map(
                                        (
                                          option
                                        ) => (
                                          <option
                                            key={
                                              option
                                            }
                                            value={
                                              option
                                            }
                                          >
                                            {
                                              option
                                            }
                                          </option>
                                        )
                                      )}
                                    </select>

                                    <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-400">
                                      <input
                                        type="checkbox"
                                        checked={
                                          conversation.needsAction
                                        }
                                        disabled={
                                          saving ||
                                          analyzing
                                        }
                                        onChange={(
                                          event
                                        ) =>
                                          changeNeedsAction(
                                            conversation.conversationId,
                                            event.target.checked
                                          )
                                        }
                                        className="h-4 w-4 accent-blue-500"
                                      />

                                      <SquareCheckBig className="h-4 w-4" />

                                      Needs Action
                                    </label>

                                    <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-400">
                                      <input
                                        type="checkbox"
                                        checked={
                                          conversation.archive
                                        }
                                        disabled={
                                          saving ||
                                          analyzing
                                        }
                                        onChange={(
                                          event
                                        ) =>
                                          changeArchive(
                                            conversation.conversationId,
                                            event.target.checked
                                          )
                                        }
                                        className="h-4 w-4 accent-blue-500"
                                      />

                                      <Archive className="h-4 w-4" />

                                      Archive
                                    </label>

                                    <input
                                      type="text"
                                      value={
                                        conversation.feedback
                                      }
                                      disabled={
                                        saving ||
                                        analyzing ||
                                        executing
                                      }
                                      onChange={(
                                        event
                                      ) =>
                                        updateConversation(
                                          conversation.conversationId,
                                          {
                                            feedback:
                                              event.target.value,
                                          }
                                        )
                                      }
                                      placeholder="Mailroom feedback"
                                      className="min-w-0 rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-1.5 text-sm text-neutral-300 outline-none placeholder:text-neutral-700 focus:border-neutral-600"
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      }
                    )}
                  </div>
                )}
              </section>
            );
          }
        )}
      </div>

      {saveError && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {
            saveError
          }
        </div>
      )}

      <section className="sticky bottom-4 rounded-xl border border-neutral-700 bg-neutral-950/95 p-4 shadow-2xl backdrop-blur">
        {!reviewComplete ? (
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-sm font-medium text-neutral-200">
                Ready to approve?
              </div>

              <div className="mt-1 text-xs text-neutral-500">
                {
                  needsActionCount
                }{" "}
                need action to save ·{" "}
                {
                  archiveCount
                }{" "}
                marked for archive to save
              </div>
            </div>

            <button
              type="button"
              onClick={
                approveReview
              }
              disabled={
                saving ||
                analyzing ||
                executing ||
                conversationsToSave.length ===
                  0
              }
              className="flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-4 w-4" />

              {saving
                ? "Saving & sending..."
                : conversationsToSave.length ===
                    0
                  ? "No changes waiting"
                  : "Go for it"}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Check className="h-5 w-5 text-emerald-400" />

            <div>
              <div className="text-sm font-medium text-neutral-200">
                Review approved and sent
              </div>

              <div className="text-xs text-neutral-500">
                Approved Needs Action and archive actions were handed off to Power Automate. Meeting requests were left untouched.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}