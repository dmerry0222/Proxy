import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret gate for trusted machine-to-machine ingestion (Power
 * Automate). Separate from PROXY_ADMIN_API_TOKEN on purpose: this secret
 * lives in a cloud flow owned by a different system, so it needs to be
 * rotatable without invalidating the admin token that manual sync/migration
 * routes depend on -- and a leak of one must not grant the other's reach.
 *
 * Callers pass `X-Proxy-Ingestion-Secret: <PROXY_INGESTION_SECRET>`.
 */
export class IngestionAuthError extends Error {
  /**
   * Distinguishes "no credential offered" (a scanner, a misconfigured flow)
   * from "wrong credential offered" (a stale secret after rotation, or
   * someone guessing). Only the latter is worth raising an issue for.
   */
  readonly presented: boolean;

  constructor(message: string, presented: boolean) {
    super(message);
    this.presented = presented;
  }
}

export const INGESTION_SECRET_HEADER = "x-proxy-ingestion-secret";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Compare lengths first: timingSafeEqual throws on a length mismatch, and
  // the length of a rejected secret is not worth protecting.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireIngestionSecret(request: Request): void {
  const expected = process.env.PROXY_INGESTION_SECRET;
  if (!expected) {
    // Treated as "presented" so it raises an issue: a deployment missing
    // its secret is a real misconfiguration, not background scanner noise.
    throw new IngestionAuthError("PROXY_INGESTION_SECRET is not configured on the server.", true);
  }

  const provided = request.headers.get(INGESTION_SECRET_HEADER);
  if (!provided) {
    throw new IngestionAuthError(`Missing ${INGESTION_SECRET_HEADER} header.`, false);
  }

  if (!safeEqual(provided, expected)) {
    throw new IngestionAuthError(`Invalid ${INGESTION_SECRET_HEADER} header.`, true);
  }
}
