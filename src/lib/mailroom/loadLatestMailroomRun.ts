import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import {
  loadMailroomConversations,
} from "@/lib/mailroom/loadMailroom";

import type {
  MailConversation,
  MailroomBucket,
} from "@/lib/mailroom/types";

type StoredConversation = {
  id: string;
  run_id: string;
  conversation_id: string;
  latest_message_id: string | null;
  category: string;
  summary: string | null;
  requires_attention: boolean;
  confidence:
    | number
    | string
    | null;
  suggested_reply:
    | string
    | null;
  created_at: string;
};

type StoredAction = {
  mailroom_conversation_id:
    string;

  outlook_message_id:
    | string
    | null;

  action_type:
    string;

  proposed_value:
    boolean;

  approved_value?:
    | boolean
    | null;
};

function databaseCategoryToUi(
  value: string
): MailroomBucket {
  switch (value) {
    case "needs_you":
      return "Needs You";

    case "fyi":
      return "FYI";

    case "professional_news":
      return "Professional News";

    case "low_value":
      return "Low Value";

    default:
      return "FYI";
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

export type MailroomReviewConversation =
  MailConversation & {
    mailroomConversationId:
      string | null;

    requiresAttention:
      boolean;

    confidence:
      number | null;

    suggestedReply:
      string | null;

    originalBucket:
      MailroomBucket;

    originalNeedsAction:
      boolean;

    originalArchive:
      boolean;

    acceptMeeting:
      boolean;

    /*
     * True only when this conversation belongs to the
     * current ready-for-review AI run.
     *
     * Previously reviewed Inbox items remain visible,
     * but Go For It only submits current-run items.
     */
    isPendingReview:
      boolean;

    /*
     * A previously reviewed Inbox item keeps its stored
     * summary/suggested reply without being re-analyzed.
     */
    hasStoredAnalysis:
      boolean;
  };

async function loadStoredConversations(
  conversationIds: string[]
): Promise<StoredConversation[]> {
  if (
    conversationIds.length ===
    0
  ) {
    return [];
  }

  const CHUNK_SIZE =
    50;

  const rows:
    StoredConversation[] =
      [];

  for (
    let index = 0;
    index <
    conversationIds.length;
    index +=
      CHUNK_SIZE
  ) {
    const chunk =
      conversationIds.slice(
        index,
        index +
          CHUNK_SIZE
      );

    const {
      data,
      error,
    } =
      await supabaseServer
        .from(
          "mailroom_conversations"
        )
        .select(
          `
          id,
          run_id,
          conversation_id,
          latest_message_id,
          category,
          summary,
          requires_attention,
          confidence,
          suggested_reply,
          created_at
          `
        )
        .in(
          "conversation_id",
          chunk
        )
        .order(
          "created_at",
          {
            ascending:
              false,
          }
        );

    if (error) {
      throw new Error(
        `Could not load stored Mailroom analyses: ${error.message}`
      );
    }

    rows.push(
      ...(
        (data ??
          []) as StoredConversation[]
      )
    );
  }

  return rows;
}

async function loadStoredActions(
  mailroomConversationIds: string[]
): Promise<StoredAction[]> {
  if (
    mailroomConversationIds.length ===
    0
  ) {
    return [];
  }

  const CHUNK_SIZE =
    50;

  const rows:
    StoredAction[] =
      [];

  for (
    let index = 0;
    index <
    mailroomConversationIds.length;
    index +=
      CHUNK_SIZE
  ) {
    const chunk =
      mailroomConversationIds.slice(
        index,
        index +
          CHUNK_SIZE
      );

    const {
      data,
      error,
    } =
      await supabaseServer
        .from(
          "mailroom_actions"
        )
        .select(
          `
          mailroom_conversation_id,
          outlook_message_id,
          action_type,
          proposed_value,
          approved_value
          `
        )
        .in(
          "mailroom_conversation_id",
          chunk
        );

    if (error) {
      throw new Error(
        `Could not load stored Mailroom actions: ${error.message}`
      );
    }

    rows.push(
      ...(
        (data ??
          []) as StoredAction[]
      )
    );
  }

  return rows;
}

export async function loadLatestMailroomRun(): Promise<{
  runId: string | null;
  conversations: MailroomReviewConversation[];
}> {
  /*
   * DISPLAY STATE
   *
   * Mailroom shows every message/conversation that Outlook
   * currently says is still in Inbox, regardless of whether
   * Proxy has already analyzed it.
   */
  const liveConversations =
    await loadMailroomConversations({
      includeProcessed:
        true,
      limit:
        1000,
    });

  /*
   * REVIEW STATE
   *
   * Only a ready_for_review run is actionable.
   * Approved/executing/completed runs are historical state,
   * not something Go For It should submit again.
   */
  const {
    data:
      reviewRun,
    error:
      runError,
  } =
    await supabaseServer
      .from(
        "mailroom_runs"
      )
      .select(
        "id, completed_at"
      )
      .eq(
        "status",
        "ready_for_review"
      )
      .order(
        "completed_at",
        {
          ascending:
            false,
        }
      )
      .limit(1)
      .maybeSingle();

  if (runError) {
    throw new Error(
      `Could not load current Mailroom review run: ${runError.message}`
    );
  }

  const liveConversationIds =
    liveConversations.map(
      (
        conversation
      ) =>
        conversation.conversationId
    );

  /*
   * Load the durable Mailroom interpretation history for
   * currently-live Inbox conversations.
   *
   * We are intentionally NOT restricting this to one run.
   * That is what lets a suggested reply survive while the
   * email remains in Inbox across later Mailroom batches.
   */
  const storedConversations =
    await loadStoredConversations(
      liveConversationIds
    );

  /*
   * Pick the newest stored interpretation for each Outlook
   * conversation.
   */
  const latestStoredByConversation =
    new Map<
      string,
      StoredConversation
    >();

  for (
    const stored
    of storedConversations
  ) {
    const existing =
      latestStoredByConversation.get(
        stored.conversation_id
      );

    if (
      !existing ||
      new Date(
        stored.created_at
      ).getTime() >
        new Date(
          existing.created_at
        ).getTime()
    ) {
      latestStoredByConversation.set(
        stored.conversation_id,
        stored
      );
    }
  }

  const latestStoredRows =
    [
      ...latestStoredByConversation.values(),
    ];

  const storedActions =
    await loadStoredActions(
      latestStoredRows.map(
        (
          conversation
        ) =>
          conversation.id
      )
    );

  const actionsByMailroomConversation =
    new Map<
      string,
      StoredAction[]
    >();

  for (
    const action
    of storedActions
  ) {
    const existing =
      actionsByMailroomConversation.get(
        action.mailroom_conversation_id
      ) ??
      [];

    existing.push(
      action
    );

    actionsByMailroomConversation.set(
      action.mailroom_conversation_id,
      existing
    );
  }

  const merged:
    MailroomReviewConversation[] =
      liveConversations.map(
        (
          conversation
        ) => {
          const analysis =
            latestStoredByConversation.get(
              conversation.conversationId
            );

          /*
           * If an existing conversation has received a NEW,
           * unprocessed Inbox message since its last analysis,
           * don't pretend the old interpretation applies to
           * the new edge of the thread.
           *
           * Until Analyze Next Batch runs, show the live
           * fallback state instead.
           */
          const analysisIsCurrentForThread =
            Boolean(
              analysis &&
              (
                analysis.latest_message_id ===
                  conversation.latestMessageId ||
                !conversation
                  .hasUnprocessedInboxMessages
              )
            );

          if (
            !analysis ||
            !analysisIsCurrentForThread
          ) {
            const defaults =
              defaultActionsForBucket(
                conversation.bucket
              );

            return {
              ...conversation,

              needsAction:
                defaults.needsAction,

              archive:
                defaults.archive,

              mailroomConversationId:
                null,

              requiresAttention:
                false,

              confidence:
                null,

              suggestedReply:
                null,

              originalBucket:
                conversation.bucket,

              originalNeedsAction:
                defaults.needsAction,

              originalArchive:
                defaults.archive,

              acceptMeeting:
                false,

              isPendingReview:
                false,

              hasStoredAnalysis:
                false,
            };
          }

          const actions =
            actionsByMailroomConversation.get(
              analysis.id
            ) ??
            [];

          const latestInboxMessageId =
            [
              ...conversation.messages,
            ]
              .reverse()
              .find(
                (
                  message
                ) =>
                  message.isInInbox ===
                  true
              )
              ?.outlookMessageId ??
            null;

          const archiveAction =
            actions.find(
              (
                action
              ) =>
                action.action_type ===
                  "archive" &&
                action.outlook_message_id ===
                  latestInboxMessageId
            );

          const needsActionAction =
            actions.find(
              (
                action
              ) =>
                action.action_type ===
                  "needs_action" &&
                action.outlook_message_id ===
                  latestInboxMessageId
            );

          /*
           * Legacy compatibility for old Mailroom runs.
           */
          const legacyFlagAction =
            actions.find(
              (
                action
              ) =>
                action.action_type ===
                  "flag" &&
                action.outlook_message_id ===
                  latestInboxMessageId
            );

          const bucket =
            databaseCategoryToUi(
              analysis.category
            );

          const defaults =
            defaultActionsForBucket(
              bucket
            );

          const needsAction =
            needsActionAction
              ?.approved_value ??
            needsActionAction
              ?.proposed_value ??
            legacyFlagAction
              ?.approved_value ??
            legacyFlagAction
              ?.proposed_value ??
            defaults.needsAction;

          let archive =
            archiveAction
              ?.approved_value ??
            archiveAction
              ?.proposed_value ??
            defaults.archive;

          if (
            needsAction &&
            archive
          ) {
            archive =
              false;
          }

          const isPendingReview =
            reviewRun?.id ===
            analysis.run_id;

          return {
            ...conversation,

            mailroomConversationId:
              analysis.id,

            bucket,

            summary:
              analysis.summary ??
              conversation.summary,

            needsAction,

            archive,

            requiresAttention:
              analysis.requires_attention,

            confidence:
              analysis.confidence ===
              null
                ? null
                : Number(
                    analysis.confidence
                  ),

            suggestedReply:
              analysis.suggested_reply,

            originalBucket:
              bucket,

            originalNeedsAction:
              needsAction,

            originalArchive:
              archive,

            acceptMeeting:
              false,

            isPendingReview,

            hasStoredAnalysis:
              true,
          };
        }
      );

  return {
    runId:
      reviewRun?.id ??
      null,

    conversations:
      merged,
  };
}
