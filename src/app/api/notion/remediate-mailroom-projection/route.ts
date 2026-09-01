import { NextResponse } from "next/server";

import { AdminAuthError, requireAdminAuth } from "@/lib/auth/adminAuth";
import { completeTrace, emitDiagnosticEvent, recordIssue, startTrace } from "@/lib/diagnostics/emitEvent";
import { supabaseServer } from "@/lib/supabase/server";
import { notionClient } from "@/lib/notion/client";
import { readMailroomPage } from "@/lib/notion/readMailroomPage";

/**
 * One-time repair for the Notion Mailroom pages created by the pre-fix
 * syncMailroomToNotion, which projected every live Inbox conversation --
 * including ones with no Mailroom analysis at all -- as if it were a
 * normal reviewable row. Run once after deploying the eligibility filter
 * (syncMailroom.ts / analysisReadiness.ts); safe to re-run, since a page
 * that's already archived or that now has a real analysis simply won't
 * match the orphan query below a second time.
 *
 * Does NOT touch the surface_objects mapping (conversation_id -> Notion
 * page id): that mapping is exactly what lets the SAME physical page be
 * reused/updated once real analysis exists (see unarchiveOnUpdate in
 * pageSync.ts / syncMailroom.ts) instead of a duplicate being created.
 *
 * Does NOT delete anything. For each orphaned page:
 *   - if the live page shows genuine human review evidence (Submitted
 *     checked, or a Human Reply Edit / Human Instruction typed in) despite
 *     never having had an analysis, it is left untouched and reported
 *     under `flaggedForManualReview` -- this is not archived automatically
 *     since a human may have acted on it and that must not be hidden
 *     silently.
 *   - otherwise the page is archived in Notion (`archived: true`), which
 *     removes it from Dave's default database views without deleting any
 *     data. It reappears automatically, with real analysis, the next time
 *     syncMailroomToNotion() runs after that conversation becomes eligible
 *     (see unarchiveOnUpdate).
 */
export async function POST(request: Request) {
  try {
    requireAdminAuth(request);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 401 });
    }
    throw error;
  }

  const traceId = await startTrace({
    module: "notion",
    sourceType: "admin_remediation",
    summary: "Remediate Mailroom Notion pages projected without an analysis",
  });

  try {
    const { data: mappings, error: mappingsError } = await supabaseServer
      .from("surface_objects")
      .select("id, proxy_object_id, external_object_id")
      .eq("surface_type", "notion")
      .eq("object_type", "mailroom_conversation");

    if (mappingsError) {
      throw new Error(`Could not load Mailroom surface mappings: ${mappingsError.message}`);
    }

    const { data: analyzedRows, error: analyzedError } = await supabaseServer
      .from("mailroom_conversations")
      .select("conversation_id");

    if (analyzedError) {
      throw new Error(`Could not load analyzed conversation ids: ${analyzedError.message}`);
    }

    const analyzedConversationIds = new Set((analyzedRows ?? []).map((row) => row.conversation_id as string));

    const orphaned = (mappings ?? []).filter(
      (mapping) => !analyzedConversationIds.has(mapping.proxy_object_id as string) && mapping.external_object_id
    );

    const archived: string[] = [];
    const alreadyArchived: string[] = [];
    const flaggedForManualReview: Array<{ conversationId: string; pageId: string; reason: string }> = [];
    const failures: Array<{ conversationId: string; pageId: string; error: string }> = [];

    for (const mapping of orphaned) {
      const conversationId = mapping.proxy_object_id as string;
      const pageId = mapping.external_object_id as string;

      try {
        /*
         * Check live archive state BEFORE deciding anything: Notion's API
         * rejects pages.update (any property, not just re-archiving) on a
         * page that is already archived ("Can't edit block that is
         * archived"), and a page found already archived here needs no
         * action -- it is already hidden from Dave's default views, which
         * is exactly the end state this route is trying to reach.
         */
        const rawPage = await notionClient.pages.retrieve({ page_id: pageId });
        if ("archived" in rawPage && rawPage.archived) {
          alreadyArchived.push(pageId);
          continue;
        }

        const page = await readMailroomPage(pageId);
        const hasHumanReviewEvidence =
          page.reviewed.submitted === true ||
          Boolean(page.reviewed.humanReplyEdit) ||
          Boolean(page.reviewed.humanInstruction);

        if (hasHumanReviewEvidence) {
          flaggedForManualReview.push({
            conversationId,
            pageId,
            reason: page.reviewed.submitted
              ? "Submitted was checked on a row that was never analyzed."
              : "A human reply edit or instruction was recorded on a row that was never analyzed.",
          });
          continue;
        }

        await notionClient.pages.update({ page_id: pageId, archived: true });
        archived.push(pageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        failures.push({ conversationId, pageId, error: message });
      }
    }

    if (flaggedForManualReview.length > 0) {
      await recordIssue({
        traceId,
        issueType: "mailroom_unanalyzed_row_reviewed",
        severity: "warning",
        humanSummary: `${flaggedForManualReview.length} Mailroom Notion page(s) had human review evidence despite never being analyzed; left untouched for manual review.`,
        metadata: { flaggedForManualReview },
        retryable: false,
      });
    }

    if (failures.length > 0) {
      await recordIssue({
        traceId,
        issueType: "mailroom_remediation_failed",
        severity: "error",
        humanSummary: `${failures.length} orphaned Mailroom page(s) could not be archived.`,
        metadata: { failures },
        retryable: true,
      });
    }

    await emitDiagnosticEvent({
      traceId,
      module: "notion",
      stage: "remediate_mailroom_projection",
      eventType: "remediation_completed",
      status: failures.length > 0 ? "failure" : "success",
      humanSummary: `Remediated ${orphaned.length} orphaned Mailroom page(s): ${archived.length} newly archived, ${alreadyArchived.length} already archived, ${flaggedForManualReview.length} flagged for manual review, ${failures.length} failed.`,
      metadata: {
        totalOrphaned: orphaned.length,
        archived: archived.length,
        alreadyArchived: alreadyArchived.length,
        flaggedForManualReview,
        failures,
      },
    });

    await completeTrace(traceId, {
      status: failures.length > 0 ? "failed" : "completed",
      summary: `${archived.length} newly archived, ${alreadyArchived.length} already archived, ${flaggedForManualReview.length} flagged, ${failures.length} failed (of ${orphaned.length} orphaned pages).`,
    });

    return NextResponse.json({
      success: failures.length === 0,
      traceId,
      totalOrphaned: orphaned.length,
      archived,
      alreadyArchived,
      flaggedForManualReview,
      failures,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await completeTrace(traceId, { status: "failed", summary: message });
    return NextResponse.json({ success: false, traceId, error: message }, { status: 500 });
  }
}
