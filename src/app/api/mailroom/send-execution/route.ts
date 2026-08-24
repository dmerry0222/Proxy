import { NextResponse } from "next/server";
import { Resend } from "resend";

import { supabaseServer } from "@/lib/supabase/server";

const resend =
  new Resend(
    process.env.RESEND_API_KEY
  );

type ActionRow = {
  id: string;
  outlook_message_id: string;

  action_type:
    | "archive"
    | "needs_action"
    | "flag"
    | "accept_meeting";
};

export async function POST(
  request: Request
) {
  try {
    const {
      runId,
    } =
      (
        await request.json()
      ) as {
        runId: string;
      };

    if (!runId) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing runId",
        },
        {
          status: 400,
        }
      );
    }

    const {
      data: run,
      error: runError,
    } =
      await supabaseServer
        .from("mailroom_runs")
        .select(
          "id, status"
        )
        .eq(
          "id",
          runId
        )
        .maybeSingle();

    if (runError) {
      throw new Error(
        `Could not load run: ${runError.message}`
      );
    }

    if (!run) {
      throw new Error(
        "Mailroom run not found"
      );
    }

    if (
      run.status !==
      "approved"
    ) {
      throw new Error(
        "Mailroom run has not been approved"
      );
    }

    const {
      data: conversations,
      error: conversationError,
    } =
      await supabaseServer
        .from(
          "mailroom_conversations"
        )
        .select("id")
        .eq(
          "run_id",
          runId
        );

    if (conversationError) {
      throw new Error(
        `Could not load conversations: ${conversationError.message}`
      );
    }

    const conversationIds =
      (
        conversations ??
        []
      ).map(
        (
          conversation
        ) =>
          conversation.id
      );

    let actions:
      ActionRow[] =
        [];

    if (
      conversationIds.length >
      0
    ) {
      const {
        data: actionData,
        error: actionError,
      } =
        await supabaseServer
          .from(
            "mailroom_actions"
          )
          .select(
            `
            id,
            outlook_message_id,
            action_type
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
          `Could not load actions: ${actionError.message}`
        );
      }

      actions =
        (
          actionData ??
          []
        ) as ActionRow[];
    }

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

          value: true,
        })
      );

    const payload = {
      version: 1,

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

    const executionEmail =
      process.env
        .PROXY_EXECUTION_EMAIL;

    if (!executionEmail) {
      throw new Error(
        "Missing PROXY_EXECUTION_EMAIL"
      );
    }

    /*
     * IMPORTANT:
     *
     * Mark the run executing BEFORE sending the trigger email.
     *
     * Power Automate may execute very quickly and its final
     * complete_mailroom_run RPC expects this run to already
     * be in executing state.
     */
    const {
      error: executingError,
    } =
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .update({
          status:
            "executing",
        })
        .eq(
          "id",
          runId
        )
        .eq(
          "status",
          "approved"
        );

    if (executingError) {
      throw new Error(
        `Could not mark Mailroom run as executing: ${executingError.message}`
      );
    }

    const {
      data: emailData,
      error: emailError,
    } =
      await resend.emails.send({
        from:
          "Proxy <onboarding@resend.dev>",

        to:
          executionEmail,

        subject:
          `PROXY_MAILROOM_EXECUTE::${runId}`,

        text:
          JSON.stringify(
            payload,
            null,
            2
          ),
      });

    if (emailError) {
      /*
       * Execution never left Proxy, so restore the run
       * to approved and allow another attempt.
       */
      await supabaseServer
        .from(
          "mailroom_runs"
        )
        .update({
          status:
            "approved",

          error_message:
            `Execution email failed: ${emailError.message}`,
        })
        .eq(
          "id",
          runId
        )
        .eq(
          "status",
          "executing"
        );

      throw new Error(
        `Resend failed: ${emailError.message}`
      );
    }

    return NextResponse.json({
      success: true,

      runId,

      actionCount:
        executionActions.length,

      resendEmailId:
        emailData?.id ??
        null,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : "Unknown execution error",
      },
      {
        status: 500,
      }
    );
  }
}