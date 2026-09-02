import "server-only";

import { timingSafeEqual } from "node:crypto";

/**
 * The constant-time comparison every shared-secret gate in this app needs.
 *
 * Extracted because three copies of it existed (adminAuth, ingestionAuth, and
 * now captureAuth), and a security primitive that is copied is a security
 * primitive that eventually gets fixed in only two places.
 *
 * The gates themselves stay separate. Each secret has a different blast
 * radius and a different rotation story -- an admin token in a terminal, an
 * ingestion secret inside a Power Automate flow, a capture secret sitting on
 * a phone in Dave's pocket -- so one leaking must never grant another's
 * reach. What they share is arithmetic, not authority.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  // timingSafeEqual throws on a length mismatch, and the length of a rejected
  // secret is not worth protecting.
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
