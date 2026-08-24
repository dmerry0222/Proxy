import { NextResponse } from "next/server";
import { ingestEmailToMemory } from "@/lib/memory/ingestEmail";
import { supabaseServer } from "@/lib/supabase/server";

type ReviewItem = {
  conversationId: string;
  mailroomConversationId: string | null;
  isPendingReview: boolean;

  latestMessageId: string;
  inboxMessageIds: string[];

  systemType:
    | "workday"
    | "calendar_response"
    | "meeting_request"
    | null
    | undefined;

  bucket:
    | "Needs You"
    | "FYI"
    | "Professional News"
    | "Low Value";

  originalBucket:
    | "Needs You"
    | "FYI"
    | "Professional News"
    | "Low Value";

  needsAction: boolean;
  originalNeedsAction: boolean;

  archive: boolean;
  originalArchive: boolean;

  feedback: string;
};

type ReviewPayload = {
  runId: string | null;
  conversations: ReviewItem[];
};

type SourceConversation = {
  summary: string | null;
  requires_attention: boolean;
  confidence: number | string | null;
  suggested_reply: string | null;
};

function categoryToDatabase(
  category: ReviewItem["bucket"]
) {
  return category
    .toLowerCase()
    .replaceAll(" ", "_");
}

async function createManualReviewRun(
  conversations: ReviewItem[]
) {
  const uniqueMessageIds =
    [
      ...new Set(
        conversations
          .flatMap(
            (item) =>
              item.inboxMessageIds ??
              []
          )
          .filter(Boolean)
      ),
    ];

  const {
    data,
    error,
  } =
    await supabaseServer
      .from("mailroom_runs")
      .insert({
        status:
          "processing",

        model_provider:
          "manual",

        model_name:
          "mailroom-review-adjustment",

        messages_considered:
          uniqueMessageIds.length,

        conversations_considered:
          conversations.length,
      })
      .select("id")
      .single();

  if (
    error ||
    !data
  ) {
    throw new Error(
      `Could not create Mailroom adjustment run: ${
        error?.message ??
        "Unknown error"
      }`
    );
  }

  return data.id;
}

async function loadSourceConversation(
  mailroomConversationId:
    string | null
): Promise<
  SourceConversation | null
> {
  if (
    !mailroomConversationId
  ) {
    return null;
  }

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
        summary,
        requires_attention,
        confidence,
        suggested_reply
        `
      )
      .eq(
        "id",
        mailroomConversationId
      )
      .maybeSingle();

  if (error) {
    throw new Error(
      `Could not load existing Mailroom context: ${error.message}`
    );
  }

  return (
    data as SourceConversation | null
  );
}

async function ensureMailroomConversation(
  runId: string,
  item: ReviewItem
) {
  /*
   * A pending item already belongs to the target AI run.
   * Keep using that stored interpretation directly.
   */
  if (
    item.isPendingReview &&
    item.mailroomConversationId
  ) {
    return item.mailroomConversationId;
  }

  /*
   * A previously reviewed Inbox item is being edited again.
   *
   * Copy its durable interpretation into the current review
   * run (or a new manual adjustment run) so:
   * - execution belongs to THIS save
   * - the old historical run is left untouched
   * - summary / confidence / suggested reply survive
   */
  const source =
    await loadSourceConversation(
      item.mailroomConversationId
    );

  const itemType =
    item.systemType ===
    "meeting_request"
      ? "meeting_request"
      : item.systemType ===
        "workday"
        ? "workday_system"
        : item.systemType ===
          "calendar_response"
          ? "calendar_system"
          : "conversation";

  const category =
    item.systemType ===
    "workday"
      ? "workday_system"
      : item.systemType ===
          "calendar_response" ||
        item.systemType ===
          "meeting_request"
        ? "calendar_system"
        : categoryToDatabase(
            item.bucket
          );

  const {
    data,
    error,
  } =
    await supabaseServer
      .from(
        "mailroom_conversations"
      )
      .upsert(
        {
          run_id:
            runId,

          conversation_id:
            item.conversationId,

          latest_message_id:
            item.latestMessageId,

          item_type:
            itemType,

          category,

          summary:
            source?.summary ??
            null,

          requires_attention:
            source
              ?.requires_attention ??
            (
              item.systemType ===
              "meeting_request"
            ),

          confidence:
            source?.confidence ??
            null,

          suggested_reply:
            source
              ?.suggested_reply ??
            null,
        },
        {
          onConflict:
            "run_id,conversation_id",
        }
      )
      .select("id")
      .single();

  if (
    error ||
    !data
  ) {
    throw new Error(
      `Could not create review record: ${
        error?.message ??
        "Unknown error"
      }`
    );
  }

  return data.id;
}

async function saveAction(
  mailroomConversationId: string,
  outlookMessageId: string,
  actionType:
    | "archive"
    | "needs_action",
  finalValue: boolean,
  defaultProposedValue:
    boolean = finalValue
) {
  const {
    data:
      existing,
    error:
      lookupError,
  } =
    await supabaseServer
      .from(
        "mailroom_actions"
      )
      .select(
        "id, proposed_value"
      )
      .eq(
        "mailroom_conversation_id",
        mailroomConversationId
      )
      .eq(
        "outlook_message_id",
        outlookMessageId
      )
      .eq(
        "action_type",
        actionType
      )
      .maybeSingle();

  if (
    lookupError
  ) {
    throw new Error(
      `Could not inspect ${actionType}: ${lookupError.message}`
    );
  }

  if (existing) {
    const {
      error:
        updateError,
    } =
      await supabaseServer
        .from(
          "mailroom_actions"
        )
        .update({
          approved_value:
            finalValue,

          status:
            "approved",
        })
        .eq(
          "id",
          existing.id
        );

    if (
      updateError
    ) {
      throw new Error(
        `Could not approve ${actionType}: ${updateError.message}`
      );
    }

    return;
  }

  const {
    error:
      insertError,
  } =
    await supabaseServer
      .from(
        "mailroom_actions"
      )
      .insert({
        mailroom_conversation_id:
          mailroomConversationId,

        outlook_message_id:
          outlookMessageId,

        action_type:
          actionType,

        proposed_value:
          defaultProposedValue,

        approved_value:
          finalValue,

        status:
          "approved",
      });

  if (
    insertError
  ) {
    throw new Error(
      `Could not save ${actionType}: ${insertError.message}`
    );
  }
}

async function markMessagesProcessed(
  processedMessageIds:
    string[]
) {
  const PROCESS_BATCH_SIZE =
    10;

  for (
    let index = 0;
    index <
    processedMessageIds.length;
    index +=
      PROCESS_BATCH_SIZE
  ) {
    const batch =
      processedMessageIds.slice(
        index,
        index +
          PROCESS_BATCH_SIZE
      );

    const results =
      await Promise.all(
        batch.map(
          async (
            outlookMessageId
          ) => {
            const {
              error,
            } =
              await supabaseServer
                .from(
                  "emails"
                )
                .update({
                  processed:
                    true,
                })
                .eq(
                  "outlook_message_id",
                  outlookMessageId
                );

            return {
              outlookMessageId,
              error,
            };
          }
        )
      );

    const failed =
      results.find(
        (result) =>
          result.error
      );

    if (failed) {
      throw new Error(
        `Could not mark reviewed mail as processed for message ${failed.outlookMessageId}: ${failed.error?.message}`
      );
    }
  }
}

async function ingestProcessedMessagesToMemory(
  processedMessageIds: string[]
) {
  if (
    processedMessageIds.length ===
    0
  ) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  let succeeded =
    0;

  let failed =
    0;

  /*
   * Deliberately sequential for now.
   *
   * Memory ingestion calls Claude, so this avoids bursting
   * several model requests at once while we're still
   * calibrating the production path.
   */
  for (
    const outlookMessageId
    of processedMessageIds
  ) {
    try {
      await ingestEmailToMemory(
        outlookMessageId
      );

      succeeded +=
        1;
    } catch (error) {
      failed +=
        1;

      /*
       * Memory is downstream enrichment.
       *
       * A Memory failure must never undo an otherwise
       * successful Mailroom review.
       */
      console.error(
        `Memory ingestion failed for Outlook message ${outlookMessageId}:`,
        error
      );
    }
  }

  return {
    attempted:
      processedMessageIds.length,

    succeeded,

    failed,
  };
}

export async function POST(
  request: Request
) {
  let effectiveRunId:
    string | null =
      null;

  let createdManualRun =
    false;

  try {
    const payload =
      (
        await request.json()
      ) as ReviewPayload;

    if (
      !payload.conversations ||
      payload.conversations.length ===
        0
    ) {
      return NextResponse.json(
        {
          success:
            false,

          error:
            "There are no Mailroom changes to save.",
        },
        {
          status:
            400,
        }
      );
    }

    /*
     * If an AI batch is waiting, save everything into that run.
     *
     * If Dave is only editing previously reviewed Inbox items,
     * create a tiny manual run so the new actions have a clean,
     * deterministic execution envelope of their own.
     */
    effectiveRunId =
      payload.runId;

    if (
      !effectiveRunId
    ) {
      effectiveRunId =
        await createManualReviewRun(
          payload.conversations
        );

      createdManualRun =
        true;
    }

    for (
      const item
      of payload.conversations
    ) {
      /*
       * Both may be false, but they may never both be true.
       */
      if (
        item.needsAction &&
        item.archive
      ) {
        throw new Error(
          `Conversation "${item.conversationId}" cannot be both Needs Action and Archive.`
        );
      }
if (!effectiveRunId) {
  throw new Error("Could not determine effective Mailroom run ID.");
}
      const mailroomConversationId =
        await ensureMailroomConversation(
          effectiveRunId,
          item
        );

      if (
        !item.systemType
      ) {
        /*
         * For a copied, previously reviewed item, use the
         * original reviewed value as proposed_value.
         *
         * That preserves whether a false Needs Action value
         * represents an actual change that Power Automate
         * should undo.
         */
        await saveAction(
          mailroomConversationId,
          item.latestMessageId,
          "needs_action",
          item.needsAction,
          item.originalNeedsAction
        );

        await saveAction(
          mailroomConversationId,
          item.latestMessageId,
          "archive",
          item.archive,
          item.originalArchive
        );

        const categoryChanged =
          item.bucket !==
          item.originalBucket;

        const needsActionChanged =
          item.needsAction !==
          item.originalNeedsAction;

        const archiveChanged =
          item.archive !==
          item.originalArchive;

        const hasFeedback =
          item.feedback
            .trim()
            .length >
          0;

        if (
          categoryChanged ||
          needsActionChanged ||
          archiveChanged ||
          hasFeedback
        ) {
          const {
            error:
              feedbackError,
          } =
            await supabaseServer
              .from(
                "mailroom_feedback"
              )
              .insert({
                mailroom_conversation_id:
                  mailroomConversationId,

                feedback_text:
                  item.feedback.trim() ||
                  null,

                original_category:
                  categoryToDatabase(
                    item.originalBucket
                  ),

                corrected_category:
                  categoryToDatabase(
                    item.bucket
                  ),

                original_needs_action:
                  item.originalNeedsAction,

                corrected_needs_action:
                  item.needsAction,

                original_archive:
                  item.originalArchive,

                corrected_archive:
                  item.archive,
              });

          if (
            feedbackError
          ) {
            throw new Error(
              `Could not save Mailroom feedback: ${feedbackError.message}`
            );
          }
        }

        const {
          error:
            categoryError,
        } =
          await supabaseServer
            .from(
              "mailroom_conversations"
            )
            .update({
              category:
                categoryToDatabase(
                  item.bucket
                ),
            })
            .eq(
              "id",
              mailroomConversationId
            );

        if (
          categoryError
        ) {
          throw new Error(
            `Could not save corrected category: ${categoryError.message}`
          );
        }
      }

      if (
        item.systemType ===
        "workday"
      ) {
        await saveAction(
          mailroomConversationId,
          item.latestMessageId,
          "archive",
          true
        );
      }

      if (
        item.systemType ===
        "calendar_response"
      ) {
        await saveAction(
          mailroomConversationId,
          item.latestMessageId,
          "archive",
          true
        );
      }

      if (
        item.systemType ===
        "meeting_request"
      ) {
        // Intentionally no execution action.
      }
    }

    const processedMessageIds =
      [
        ...new Set(
          payload.conversations
            .flatMap(
              (item) =>
                item.inboxMessageIds ??
                []
            )
            .filter(
              (
                id
              ): id is string =>
                typeof id ===
                  "string" &&
                id.length >
                  0
            )
        ),
      ];

    if (
      processedMessageIds.length >
      0
    ) {
      await markMessagesProcessed(
        processedMessageIds
      );
    }
const memoryIngestion =
  await ingestProcessedMessagesToMemory(
    processedMessageIds
  );
    const {
      error:
        runError,
    } =
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .update({
          status:
            "approved",

          completed_at:
            new Date()
              .toISOString(),
        })
        .eq(
          "id",
          effectiveRunId
        );

    if (
      runError
    ) {
      throw new Error(
        `Could not approve Mailroom run: ${runError.message}`
      );
    }

    return NextResponse.json({
  success:
    true,

  runId:
    effectiveRunId,

  reviewed:
    payload.conversations.length,

  processedMessages:
    processedMessageIds.length,

  memoryIngestion,
});
  } catch (
    error
  ) {
    console.error(
      error
    );

    /*
     * If this request created its own manual adjustment run,
     * don't leave that run stuck in processing after a failure.
     *
     * Existing AI review runs are left untouched so Dave can
     * correct the problem and retry them.
     */
    if (
      createdManualRun &&
      effectiveRunId
    ) {
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .update({
          status:
            "failed",

          completed_at:
            new Date()
              .toISOString(),

          error_message:
            error instanceof Error
              ? error.message
              : "Unknown Mailroom review error",
        })
        .eq(
          "id",
          effectiveRunId
        );
    }

    return NextResponse.json(
      {
        success:
          false,

        error:
          error instanceof Error
            ? error.message
            : "Unknown Mailroom review error",
      },
      {
        status:
          500,
      }
    );
  }
}
