import "server-only";

import { secretsMatch } from "@/lib/auth/sharedSecret";
import { getNotionWebhookSecret } from "@/lib/notion/client";

/**
 * Shared-secret gate for the Notion-originated webhook endpoint(s).
 * Deliberately separate from adminAuth: PROXY_ADMIN_API_TOKEN authenticates
 * Dave/Proxy-internal callers, while this authenticates the Notion database
 * button, which cannot send an Authorization header -- Notion's "Send
 * webhook" action only offers a flat custom-header key/value pair. Notion's
 * button config uses the header name `NOTION_WEBHOOK_SECRET`, which
 * `Headers.get` matches case-insensitively regardless of the underscores.
 */
export class NotionWebhookAuthError extends Error {}

export function requireNotionWebhookAuth(request: Request): void {
  let expected: string;
  try {
    expected = getNotionWebhookSecret();
  } catch {
    throw new NotionWebhookAuthError("NOTION_WEBHOOK_SECRET is not configured on the server.");
  }

  const provided = request.headers.get("NOTION_WEBHOOK_SECRET");
  if (!provided || !secretsMatch(provided, expected)) {
    throw new NotionWebhookAuthError("Missing or invalid NOTION_WEBHOOK_SECRET header.");
  }
}
