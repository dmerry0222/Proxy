import "server-only";

import { secretsMatch } from "@/lib/auth/sharedSecret";

/**
 * Shared-secret gate for the Capture front door.
 *
 * A DEDICATED secret, not PROXY_INGESTION_SECRET, for the reason that secret
 * documents about itself: it lives in a Power Automate flow, and this one
 * lives on Dave's phone -- in a Drafts action, a Shortcut, an NFC tag
 * automation. Those are different populations with different exposure (a lost
 * phone, a shared Shortcut) and different rotation cadences, and the whole
 * point of separating them is that rotating the one on the phone must not
 * break Outlook attachment ingestion.
 *
 * Two header forms are accepted, both carrying the same secret:
 *
 *   Authorization: Bearer <PROXY_CAPTURE_SECRET>   (preferred)
 *   X-Proxy-Capture-Secret: <PROXY_CAPTURE_SECRET>
 *
 * Bearer is preferred because it is what Drafts' and Shortcuts' HTTP actions
 * make easy, and a front door that is awkward to call from a phone is a front
 * door that does not get used. The custom header stays supported for clients
 * that reserve Authorization for their own use.
 */
export class CaptureAuthError extends Error {
  /**
   * Distinguishes "no credential offered" (a scanner, a half-built Shortcut)
   * from "wrong credential offered" (a rotated secret, someone guessing).
   * Only the latter is worth raising an issue for -- this endpoint is
   * publicly reachable, so unauthenticated probes are background noise.
   */
  readonly presented: boolean;

  constructor(message: string, presented: boolean) {
    super(message);
    this.presented = presented;
  }
}

export const CAPTURE_SECRET_HEADER = "x-proxy-capture-secret";

/** Extracts the offered secret from either accepted header form. */
export function presentedCaptureSecret(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token;
  }

  return request.headers.get(CAPTURE_SECRET_HEADER);
}

export function requireCaptureSecret(request: Request): void {
  const expected = process.env.PROXY_CAPTURE_SECRET;
  if (!expected) {
    // Treated as "presented" so it raises an issue: a deployment missing its
    // secret is a real misconfiguration, not scanner noise.
    throw new CaptureAuthError("PROXY_CAPTURE_SECRET is not configured on the server.", true);
  }

  const provided = presentedCaptureSecret(request);
  if (!provided) {
    throw new CaptureAuthError(
      `Missing credential. Send "Authorization: Bearer <secret>" or the ${CAPTURE_SECRET_HEADER} header.`,
      false
    );
  }

  if (!secretsMatch(provided, expected)) {
    throw new CaptureAuthError("Invalid capture secret.", true);
  }
}
