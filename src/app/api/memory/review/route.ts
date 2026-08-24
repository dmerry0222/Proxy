import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase/server";

type ReviewAction =
  | "confirm"
  | "outdated"
  | "keep_as_evidence"
  | "not_sure"
  | "correction"
  | "follow_up"
  | "keep_waiting"
  | "resolved"
  | "dismiss";

type ReviewPayload = {
  reviewItemId?: string;
  action?: ReviewAction;
  correctedStatement?: string;
};

const validActions: ReviewAction[] = [
  "confirm",
  "outdated",
  "keep_as_evidence",
  "not_sure",
  "correction",
  "follow_up",
  "keep_waiting",
  "resolved",
  "dismiss",
];

export async function POST(
  request: Request
) {
  try {
    const body =
      (await request.json()) as ReviewPayload;

    if (!body.reviewItemId) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing reviewItemId",
        },
        { status: 400 }
      );
    }

    if (
      !body.action ||
      !validActions.includes(body.action)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid Memory review action",
        },
        { status: 400 }
      );
    }

    if (body.action === "correction") {
      const correctedStatement =
        body.correctedStatement?.trim();

      if (!correctedStatement) {
        return NextResponse.json(
          {
            success: false,
            error: "Correction text is required",
          },
          { status: 400 }
        );
      }

      const { data, error } =
        await supabaseServer.rpc(
          "resolve_memory_review_with_correction",
          {
            target_review_item_id:
              body.reviewItemId,
            corrected_statement:
              correctedStatement,
          }
        );

      if (error) {
        throw new Error(
          `Could not save Memory correction: ${error.message}`
        );
      }

      return NextResponse.json({
        success: true,
        result: data,
      });
    }

const pendingActions: ReviewAction[] = [
  "follow_up",
  "keep_waiting",
  "resolved",
  "dismiss",
];

if (
  pendingActions.includes(
    body.action
  )
) {
  const {
    data,
    error,
  } = await supabaseServer.rpc(
    "resolve_memory_pending_review_item",
    {
      target_review_item_id:
        body.reviewItemId,

      action:
        body.action,
    }
  );

  if (error) {
    throw new Error(
      `Could not resolve pending Memory context: ${error.message}`
    );
  }

  return NextResponse.json({
    success: true,
    result: data,
  });
}

    const { data, error } =
      await supabaseServer.rpc(
        "resolve_memory_review_item",
        {
          target_review_item_id:
            body.reviewItemId,
          action: body.action,
        }
      );

    if (error) {
      throw new Error(
        `Could not resolve Memory review item: ${error.message}`
      );
    }

    return NextResponse.json({
      success: true,
      result: data,
    });
  } catch (error) {
    console.error(
      "Memory review failed:",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown Memory review error",
      },
      { status: 500 }
    );
  }
}