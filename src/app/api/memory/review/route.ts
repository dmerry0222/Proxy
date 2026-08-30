import { NextResponse } from "next/server";

import { classifyCorrectionFeedback } from "@/lib/memory/classifyCorrectionFeedback";
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

      const { data: reviewItem, error: reviewError } = await supabaseServer
        .from("memory_review_items").select("claim_id").eq("id", body.reviewItemId).single();
      if (reviewError || !reviewItem) throw new Error(`Could not load Memory review item: ${reviewError?.message ?? "Not found"}`);
      let originalStatement: string | null = null;
      if (reviewItem.claim_id) {
        const { data: claim } = await supabaseServer.from("memory_claims").select("statement")
          .eq("id", reviewItem.claim_id).maybeSingle();
        originalStatement = claim?.statement ?? null;
      }
      const intent = await classifyCorrectionFeedback({ feedback: correctedStatement, originalStatement });
      const resolutionAction = intent === "dismissal" ? "dismiss" : intent === "outdated" ? "outdated" : "not_sure";
      const { data, error } = intent === "factual_correction"
        ? await supabaseServer.rpc("resolve_memory_review_with_correction", {
            target_review_item_id: body.reviewItemId, corrected_statement: correctedStatement,
          })
        : await supabaseServer.rpc("resolve_memory_review_item", {
            target_review_item_id: body.reviewItemId, action: resolutionAction,
          });

      if (error) {
        throw new Error(
          `Could not save Memory correction: ${error.message}`
        );
      }

      return NextResponse.json({
        success: true,
        result: data,
        feedbackIntent: intent,
      });
    }

const pendingActions: ReviewAction[] = [
  "follow_up",
  "keep_waiting",
  "resolved",
];

let isPendingAction =
  pendingActions.includes(
    body.action
  );

/*
 * Dismiss is valid for both candidate claims and pending context.
 * Resolve that ambiguity from the review row instead of routing every
 * dismissal through the pending-context RPC.
 */
if (body.action === "dismiss") {
  const {
    data: reviewItem,
    error: reviewItemError,
  } = await supabaseServer
    .from("memory_review_items")
    .select("claim_id, pending_context_id")
    .eq("id", body.reviewItemId)
    .single();

  if (reviewItemError || !reviewItem) {
    throw new Error(
      `Could not identify Memory review item: ${reviewItemError?.message ?? "Review item not found"}`
    );
  }

  isPendingAction =
    Boolean(
      reviewItem.pending_context_id
    );
}

if (isPendingAction) {
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
