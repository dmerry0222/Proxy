import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

import {
  loadMailroomConversations,
} from "@/lib/mailroom/loadMailroom";

import type {
  MailConversation,
  MailroomBucket,
} from "@/lib/mailroom/types";
import { defaultRequestedAction, isRequestedAction, type RequestedAction } from "@/lib/mailroom/actionModel";

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
  requested_action: string | null;
  is_meeting_invitation: boolean | null;
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

    case "calendar":
    case "calendar_system":
      return "Calendar";

    case "workday":
    case "workday_system":
      return "Workday";

    default:
      return "FYI";
  }
}

const BUCKET_TO_CATEGORY: Record<MailroomBucket, "needs_you" | "fyi" | "professional_news" | "low_value" | "calendar" | "workday"> = {
  "Needs You": "needs_you",
  FYI: "fyi",
  "Professional News": "professional_news",
  "Low Value": "low_value",
  Calendar: "calendar",
  Workday: "workday",
};

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

    originalRequestedAction:
      RequestedAction;

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
          created_at,
          requested_action,
          is_meeting_invitation
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
            const defaultAction =
              defaultRequestedAction(BUCKET_TO_CATEGORY[conversation.bucket], conversation.isMeetingInvitation);

            return {
              ...conversation,

              requestedAction:
                defaultAction,

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

              originalRequestedAction:
                defaultAction,

              isPendingReview:
                false,

              hasStoredAnalysis:
                false,
            };
          }

          const bucket =
            databaseCategoryToUi(
              analysis.category
            );

          const isMeetingInvitation = analysis.is_meeting_invitation === true;
          const requestedAction: RequestedAction =
            isRequestedAction(analysis.requested_action)
              ? analysis.requested_action
              : defaultRequestedAction(BUCKET_TO_CATEGORY[bucket], isMeetingInvitation);

          const isPendingReview =
            reviewRun?.id ===
            analysis.run_id;

          return {
            ...conversation,

            mailroomConversationId:
              analysis.id,

            bucket,

            isMeetingInvitation,

            summary:
              analysis.summary ??
              conversation.summary,

            requestedAction,

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

            originalRequestedAction:
              requestedAction,

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
