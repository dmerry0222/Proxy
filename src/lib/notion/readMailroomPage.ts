import "server-only";

import { notionClient } from "./client";
import type { ReviewedValues } from "@/lib/mailroom/submissionReconciliation";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reads one Notion Mailroom page and extracts the human-owned review
 * fields. Tolerant by design: a property that is missing from the live
 * schema reads as null rather than throwing, so a partially-migrated
 * database degrades to "the human changed nothing" instead of failing the
 * whole submission.
 */

function selectName(properties: any, key: string): string | null {
  const property = properties?.[key];
  if (!property || property.type !== "select") return null;
  return property.select?.name ?? null;
}

function plainText(properties: any, key: string): string | null {
  const property = properties?.[key];
  if (!property || property.type !== "rich_text") return null;
  const text = (property.rich_text ?? []).map((chunk: any) => chunk?.plain_text ?? "").join("");
  return text.length > 0 ? text : null;
}

function titleText(properties: any, key: string): string | null {
  const property = properties?.[key];
  if (!property || property.type !== "title") return null;
  const text = (property.title ?? []).map((chunk: any) => chunk?.plain_text ?? "").join("");
  return text.length > 0 ? text : null;
}

function checkbox(properties: any, key: string): boolean {
  const property = properties?.[key];
  return property?.type === "checkbox" ? property.checkbox === true : false;
}

export type NotionMailroomPage = {
  pageId: string;
  conversationId: string | null;
  outlookMessageId: string | null;
  subject: string | null;
  lastEditedTime: string | null;
  reviewed: ReviewedValues;
};

export async function readMailroomPage(pageId: string): Promise<NotionMailroomPage> {
  const page: any = await notionClient.pages.retrieve({ page_id: pageId });
  const properties = page.properties ?? {};

  return {
    pageId: page.id,
    // Written by the projection on every sync, so it is the page's own
    // record of which Outlook conversation it represents -- independent of
    // whatever view or filter the row happens to sit behind in Notion.
    conversationId: plainText(properties, "Conversation ID"),
    // Identifies the specific actionable message, independent of
    // conversationId -- used to recover the underlying email when the
    // conversation's own mailroom_conversations row is missing/stale.
    outlookMessageId: plainText(properties, "Outlook Message ID"),
    subject: titleText(properties, "Conversation"),
    lastEditedTime: page.last_edited_time ?? null,
    reviewed: {
      bucketLabel: selectName(properties, "Bucket"),
      requestedActionLabel: selectName(properties, "Requested Action"),
      humanReplyEdit: plainText(properties, "Human Reply Edit"),
      humanInstruction: plainText(properties, "Human Instruction / Feedback"),
      submitted: checkbox(properties, "Submitted"),
    },
  };
}
