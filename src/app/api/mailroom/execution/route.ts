import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";

type ActionRow = {
  id: string;

  outlook_message_id: string;

  action_type:
    | "archive"
    | "needs_action"
    | "flag"
    | "accept_meeting";

  approved_value:
    boolean | null;

  mailroom_conversation_id:
    string;
};

type ConversationRow = {
  id: string;

  conversation_id: string;

  latest_message_id:
    string | null;
};

export async function GET(
  request: Request
) {
  try {
    const url =
      new URL(
        request.url
      );

    const requestedRunId =
      url.searchParams.get(
        "runId"
      );

    let runId =
      requestedRunId;

    if (!runId) {
      const {
        data:
          latestRun,
        error:
          runError,
      } =
        await supabaseServer
          .from(
            "mailroom_runs"
          )
          .select("id")
          .eq(
            "status",
            "approved"
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
          `Could not load approved Mailroom run: ${runError.message}`
        );
      }

      if (!latestRun) {
        return NextResponse.json(
          {
            success:
              false,

            error:
              "No approved Mailroom run is available.",
          },
          {
            status:
              404,
          }
        );
      }

      runId =
        latestRun.id;
    }

    const {
      data:
        run,
      error:
        runError,
    } =
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .select(
          `
          id,
          status,
          completed_at
          `
        )
        .eq(
          "id",
          runId
        )
        .maybeSingle();

    if (runError) {
      throw new Error(
        `Could not load Mailroom run: ${runError.message}`
      );
    }

    if (!run) {
      return NextResponse.json(
        {
          success:
            false,

          error:
            "Mailroom run not found.",
        },
        {
          status:
            404,
        }
      );
    }

    if (
      run.status !==
      "approved"
    ) {
      return NextResponse.json(
        {
          success:
            false,

          error:
            "Mailroom run has not been approved.",
        },
        {
          status:
            409,
        }
      );
    }

    const {
      data:
        conversationData,
      error:
        conversationError,
    } =
      await supabaseServer
        .from(
          "mailroom_conversations"
        )
        .select(
          `
          id,
          conversation_id,
          latest_message_id
          `
        )
        .eq(
          "run_id",
          runId
        );

    if (
      conversationError
    ) {
      throw new Error(
        `Could not load Mailroom conversations: ${conversationError.message}`
      );
    }

    const conversations =
      (
        conversationData ??
        []
      ) as ConversationRow[];

    const conversationIds =
      conversations.map(
        (
          conversation
        ) =>
          conversation.id
      );

    if (
      conversationIds.length ===
      0
    ) {
      return NextResponse.json({
        success:
          true,

        runId,

        actionCount:
          0,

        payload: {
          version:
            1,

          source:
            "proxy-mailroom",

          runId,

          actions:
            [],
        },
      });
    }

    const {
      data:
        actionData,
      error:
        actionError,
    } =
      await supabaseServer
        .from(
          "mailroom_actions"
        )
        .select(
          `
          id,
          mailroom_conversation_id,
          outlook_message_id,
          action_type,
          approved_value
          `
        )
        .in(
          "mailroom_conversation_id",
          conversationIds
        )
        .eq(
          "status",
          "approved"
        )
        .eq(
          "approved_value",
          true
        );

    if (actionError) {
      throw new Error(
        `Could not load approved Mailroom actions: ${actionError.message}`
      );
    }

    const actions =
      (
        actionData ??
        []
      ) as ActionRow[];

    /*
     * Only true actions become execution commands.
     *
     * needs_action=false is stored in Proxy but does
     * not generate a Power Automate instruction.
     *
     * archive=false is likewise a no-op.
     */
    const executionActions =
      actions.map(
        (
          action
        ) => ({
          actionId:
            action.id,

          outlookMessageId:
            action.outlook_message_id,

          action:
            action.action_type,

          value:
            true,
        })
      );

    const payload = {
      version:
        1,

      source:
        "proxy-mailroom",

      runId,

      generatedAt:
        new Date()
          .toISOString(),

      actionCount:
        executionActions.length,

      actions:
        executionActions,
    };

    return NextResponse.json({
      success:
        true,

      runId,

      actionCount:
        executionActions.length,

      payload,
    });
  } catch (
    error
  ) {
    console.error(
      error
    );

    return NextResponse.json(
      {
        success:
          false,

        error:
          error instanceof
          Error
            ? error.message
            : "Unknown Mailroom execution error",
      },
      {
        status:
          500,
      }
    );
  }
}