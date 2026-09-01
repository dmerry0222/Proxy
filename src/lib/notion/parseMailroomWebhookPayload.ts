/**
 * Parses the two request shapes the Mailroom submission webhook must
 * accept:
 *
 *  - Notion's real "Send webhook" database-button payload. Notion does not
 *    let a database button construct arbitrary JSON -- it always sends its
 *    own envelope (page metadata plus whichever properties were selected).
 *    That envelope is not fully specified by Notion's public docs, so this
 *    parser is deliberately tolerant: it tries every field name Notion is
 *    known/likely to use for "the page this event fired on", rather than
 *    assuming one exact shape. The one thing every observed and documented
 *    variant agrees on is that a page id is present SOMEWHERE identifying
 *    the source page -- that's all this endpoint actually needs, since the
 *    Notion page is re-read via the API afterward rather than trusted from
 *    the payload.
 *  - The legacy `{ notionPageId }` / `{ conversationId }` shape used for
 *    local/admin testing and Proxy-side retries, which predates the Notion
 *    button and has a fixed, known shape.
 *
 * Zero-import leaf module: pure function of the parsed JSON body, so it is
 * directly unit-testable against a captured sample payload without a
 * network call.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ParsedMailroomWebhookPayload = {
  notionPageId: string | null;
  conversationId: string | null;
  /** Top-level (and, when present, `data`-level) keys actually seen, for diagnostics when the real Notion shape needs recalibration. */
  observedShape: { topLevelKeys: string[]; dataKeys: string[] | null };
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function extractPageId(body: any): string | null {
  const candidates = [
    body?.data?.id,
    body?.data?.page_id,
    body?.data?.pageId,
    body?.page?.id,
    body?.page_id,
    body?.pageId,
    body?.id,
  ];
  return candidates.find(isNonEmptyString) ?? null;
}

/** Best-effort extraction of a selected rich_text/title property's plain text, in case the "Conversation ID" property was ever included as selected page content. */
function extractPropertyText(properties: any, keys: string[]): string | null {
  if (!properties || typeof properties !== "object") return null;
  for (const key of keys) {
    const property = properties[key];
    if (!property) continue;
    if (isNonEmptyString(property)) return property;
    const richText = property.rich_text ?? property.title;
    if (Array.isArray(richText)) {
      const text = richText.map((chunk: any) => chunk?.plain_text ?? "").join("");
      if (text.length > 0) return text;
    }
  }
  return null;
}

export function parseMailroomWebhookPayload(body: unknown): ParsedMailroomWebhookPayload {
  const record = (body ?? {}) as Record<string, unknown>;
  const data = record.data as Record<string, unknown> | undefined;

  const notionPageId = isNonEmptyString(record.notionPageId) ? record.notionPageId : extractPageId(record);
  const conversationId = isNonEmptyString(record.conversationId)
    ? record.conversationId
    : extractPropertyText((data as any)?.properties, ["Conversation ID"]);

  return {
    notionPageId,
    conversationId,
    observedShape: {
      topLevelKeys: Object.keys(record),
      dataKeys: data && typeof data === "object" ? Object.keys(data) : null,
    },
  };
}
