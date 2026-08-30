import "server-only";

import { Client } from "@notionhq/client";

/*
 * Env vars are validated lazily, on first actual use, rather than at module
 * load. Next.js imports every route module during `next build` to collect
 * page data, so a top-level throw here would break the production build
 * for the whole app any time Notion isn't configured yet -- not just this
 * route at request time.
 */

let cachedClient: Client | null = null;

function getRealClient(): Client {
  if (cachedClient) {
    return cachedClient;
  }

  const token = process.env.NOTION_API_TOKEN;
  if (!token) {
    throw new Error("Missing NOTION_API_TOKEN");
  }

  cachedClient = new Client({ auth: token });
  return cachedClient;
}

export const notionClient: Client = new Proxy({} as Client, {
  get(_target, prop) {
    const client = getRealClient();
    const value = Reflect.get(client as object, prop, client as object);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export function getProxyParentPageId(): string {
  const pageId = process.env.NOTION_PROXY_PARENT_PAGE_ID;
  if (!pageId) {
    throw new Error("Missing NOTION_PROXY_PARENT_PAGE_ID");
  }
  return pageId;
}

export function getNotionWebhookSecret(): string {
  const secret = process.env.NOTION_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("Missing NOTION_WEBHOOK_SECRET");
  }
  return secret;
}
