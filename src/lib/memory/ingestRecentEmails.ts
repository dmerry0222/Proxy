import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { ingestEmailToMemory } from "@/lib/memory/ingestEmail";

type BatchResult = {
  outlookMessageId: string;
  subject: string | null;
  messageAt: string | null;

  result:
    | Awaited<
        ReturnType<
          typeof ingestEmailToMemory
        >
      >
    | {
        ingested: false;
        reason: "batch_error";
        error: string;
      };
};

export async function ingestRecentEmailsForSender(
  senderEmail: string,
  limit = 8
): Promise<BatchResult[]> {
  const normalizedEmail =
    senderEmail
      .trim()
      .toLowerCase();

  /*
   * Pull more rows than requested because Outlook sync can
   * contain the same logical message in multiple folders.
   */
  const {
    data: rows,
    error,
  } = await supabaseServer
    .from("emails")
    .select(`
      outlook_message_id,
      internet_message_id,
      conversation_id,
      subject,
      message_at,
      folder,
      from_email,
      direction
    `)
    .ilike(
      "from_email",
      normalizedEmail
    )
    .order(
      "message_at",
      {
        ascending: false,
      }
    )
    .limit(
      Math.max(
        limit * 3,
        20
      )
    );

  if (error) {
    throw new Error(
      `Could not load recent emails for Memory ingestion: ${error.message}`
    );
  }

  /*
   * Remove duplicate mailbox copies.
   *
   * Prefer internet_message_id because Inbox and Archived copies
   * can have different Outlook message IDs.
   */
  const seen =
    new Set<string>();

  const unique =
    (rows ?? [])
      .filter(
        (row) =>
          row.direction
            ?.toLowerCase() ===
          "incoming"
      )
      .filter(
        (row) => {
          const key =
            row.internet_message_id ||
            [
              row.conversation_id ??
                "",
              row.subject ??
                "",
              row.message_at ??
                "",
            ].join("|");

          if (
            seen.has(key)
          ) {
            return false;
          }

          seen.add(key);

          return true;
        }
      )
      .slice(
        0,
        limit
      );

  const results:
    BatchResult[] =
      [];

  /*
   * Sequential processing is intentional during calibration.
   * One bad email should not prevent the rest from being tested.
   */
  for (
    const email
    of unique
  ) {
    try {
      const result =
        await ingestEmailToMemory(
          email.outlook_message_id
        );

      results.push({
        outlookMessageId:
          email.outlook_message_id,

        subject:
          email.subject,

        messageAt:
          email.message_at,

        result,
      });
    } catch (error) {
      results.push({
        outlookMessageId:
          email.outlook_message_id,

        subject:
          email.subject,

        messageAt:
          email.message_at,

        result: {
          ingested:
            false,

          reason:
            "batch_error",

          error:
            error instanceof
            Error
              ? error.message
              : "Unknown Memory ingestion error",
        },
      });
    }
  }

  return results;
}