import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { ingestEmailToMemory } from "@/lib/memory/ingestEmail";

type BackfillResult = {
  outlookMessageId: string;
  subject: string | null;
  messageAt: string | null;
  fromEmail: string | null;
  result:
    | Awaited<
        ReturnType<
          typeof ingestEmailToMemory
        >
      >
    | {
        ingested: false;
        reason: "backfill_error";
        error: string;
      };
};

type BackfillSummary = {
  requested: number;
  selected: number;
  processed: number;
  alreadyIngested: number;
  unresolvedSender: number;
  skipped: number;
  claimsCreated: number;
  pendingCreated: number;
  failed: number;
  results: BackfillResult[];
};

type EmailRow = {
  outlook_message_id: string;
  internet_message_id: string | null;
  conversation_id: string | null;
  subject: string | null;
  message_at: string | null;
  from_email: string | null;
  direction: string | null;
  folder: string | null;
};

function isInternalSuffolkEmail(
  email: string | null
) {
  const normalized =
    email
      ?.trim()
      .toLowerCase();

  if (!normalized) {
    return false;
  }

  return (
    normalized.endsWith(
      "@suffolk.edu"
    ) ||
    normalized.endsWith(
      "@adm.suffolk.edu"
    )
  );
}

function dedupeEmails(
  rows: EmailRow[]
) {
  const seen =
    new Set<string>();

  return rows.filter(
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
          row.from_email ??
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
  );
}

export async function backfillRecentEmails({
  days = 30,
  limit = 25,
}: {
  days?: number;
  limit?: number;
} = {}): Promise<BackfillSummary> {
  const since =
    new Date(
      Date.now() -
        days *
          24 *
          60 *
          60 *
          1000
    ).toISOString();

  /*
   * Pull a much larger candidate pool than the final
   * requested count.
   *
   * The goal of this calibration backfill is to test
   * deterministic Memory resolution with real human
   * Suffolk senders, not merely the newest inbox noise.
   */
  const candidateLimit =
    Math.max(
      limit * 20,
      500
    );

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
      from_email,
      direction,
      folder
    `)
    .gte(
      "message_at",
      since
    )
    .order(
      "message_at",
      {
        ascending: false,
      }
    )
    .limit(
      candidateLimit
    );

  if (error) {
    throw new Error(
      `Could not load emails for Memory backfill: ${error.message}`
    );
  }

  const incoming =
    (
      (rows ??
        []) as EmailRow[]
    ).filter(
      (row) =>
        row.direction
          ?.trim()
          .toLowerCase() ===
        "incoming"
    );

  const deduped =
    dedupeEmails(
      incoming
    );

  /*
   * Calibration strategy:
   *
   * 1. Internal Suffolk senders first.
   * 2. External senders only fill remaining slots.
   *
   * This lets us test org-chart identity seeding now,
   * while keeping the function reusable later.
   */
  const internal =
    deduped.filter(
      (row) =>
        isInternalSuffolkEmail(
          row.from_email
        )
    );

  const external =
    deduped.filter(
      (row) =>
        !isInternalSuffolkEmail(
          row.from_email
        )
    );

  const selected =
    [
      ...internal,
      ...external,
    ].slice(
      0,
      limit
    );

  const results:
    BackfillResult[] =
      [];

  let processed =
    0;

  let alreadyIngested =
    0;

  let unresolvedSender =
    0;

  let skipped =
    0;

  let claimsCreated =
    0;

  let pendingCreated =
    0;

  let failed =
    0;

  /*
   * Deliberately sequential.
   *
   * This is still calibration infrastructure, and each
   * successful resolved email may invoke Claude.
   */
  for (
    const email
    of selected
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

        fromEmail:
          email.from_email,

        result,
      });

      if (
        result.reason ===
        "already_ingested"
      ) {
        alreadyIngested +=
          1;

        continue;
      }

      if (
        result.reason ===
        "sender_not_resolved"
      ) {
        unresolvedSender +=
          1;

        continue;
      }

      if (
        "skipped" in
          result &&
        result.skipped
      ) {
        skipped +=
          1;
      }

      if (
        result.ingested
      ) {
        processed +=
          1;
      }

      if (
        "claimsCreated" in
        result
      ) {
        claimsCreated +=
          result.claimsCreated ??
          0;
      }

      if (
        "pendingCreated" in
        result
      ) {
        pendingCreated +=
          result.pendingCreated ??
          0;
      }
    } catch (error) {
      failed +=
        1;

      results.push({
        outlookMessageId:
          email.outlook_message_id,

        subject:
          email.subject,

        messageAt:
          email.message_at,

        fromEmail:
          email.from_email,

        result: {
          ingested:
            false,

          reason:
            "backfill_error",

          error:
            error instanceof
            Error
              ? error.message
              : "Unknown Memory backfill error",
        },
      });
    }
  }

  return {
    requested:
      limit,

    selected:
      selected.length,

    processed,

    alreadyIngested,

    unresolvedSender,

    skipped,

    claimsCreated,

    pendingCreated,

    failed,

    results,
  };
}