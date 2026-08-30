import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret gate for internal/admin API routes that must not be
 * callable anonymously (manual sync triggers, future retry endpoints,
 * etc.) but have no end-user session to check against -- this app has no
 * auth layer, only the service-role Supabase key. Callers pass
 * `Authorization: Bearer <PROXY_ADMIN_API_TOKEN>`.
 */
export class AdminAuthError extends Error {}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireAdminAuth(request: Request): void {
  const expected = process.env.PROXY_ADMIN_API_TOKEN;
  if (!expected) {
    throw new AdminAuthError("PROXY_ADMIN_API_TOKEN is not configured on the server.");
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token || !safeEqual(token, expected)) {
    throw new AdminAuthError("Missing or invalid Authorization bearer token.");
  }
}
