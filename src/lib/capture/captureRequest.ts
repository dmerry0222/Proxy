/**
 * Validation and normalization for the Capture payload. Pure, zero-import
 * leaf module -- same shape as externalArtifactRequest.ts -- so every accept
 * and reject rule is unit testable without a live request, a database, or a
 * phone.
 *
 * This is the trust boundary. Bodies arrive from a Drafts action, a Shortcut,
 * or an NFC tag automation, none of which have schema enforcement of their
 * own, so everything is unknown until proven otherwise.
 *
 * The governing bias: NEVER LOSE A CAPTURE TO A TAXONOMY. `content` is the
 * only thing a caller can get wrong badly enough to be rejected for. An
 * unrecognized capture_type, an unparseable timestamp, a metadata blob full
 * of fields Proxy has never heard of -- all of those are recorded, not
 * refused, because the person who typed the thing has already moved on and
 * cannot act on a 400.
 *
 * `source` is the one exception, and only because it is a small closed set
 * that a database CHECK enforces anyway: an unrecognized source is far more
 * likely to be a typo in a Shortcut than a new integration, and accepting the
 * typo would quietly corrupt every later question about where captures come
 * from. The error names the valid values so the fix is obvious.
 */

/** Keep in sync with the `captures_source_check` constraint. */
export const CAPTURE_SOURCES = [
  "drafts",
  "ios_shortcut",
  "proxy_ui",
  "share_sheet",
  "nfc",
  "other",
] as const;

export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/**
 * Types Proxy recognizes today. Advisory only: this list shapes what a future
 * processor knows how to route, and nothing here rejects a value that is
 * absent from it. A capture_type of "voice_memo_from_the_car" is stored
 * exactly as sent, and shows up as an unrecognized type in diagnostics --
 * which is how the vocabulary is supposed to grow.
 */
export const RECOGNIZED_CAPTURE_TYPES = [
  "quick_add",
  "quick_add_task",
  "long_ramble",
  "note",
  "idea",
  "log",
] as const;

export const DEFAULT_CAPTURE_TYPE = "quick_add";

/**
 * Generous ceiling. A "long ramble" dictated on a walk is a first-class use
 * case, so this is set well above anything a human types or dictates in one
 * sitting, and exists only so a runaway client cannot post a novel.
 */
export const MAX_CONTENT_LENGTH = 100_000;
export const MAX_CAPTURE_TYPE_LENGTH = 80;
export const MAX_EXTERNAL_ID_LENGTH = 200;

export type CaptureRequest = {
  source: CaptureSource;
  captureType: string;
  content: string;
  sourceExternalId: string | null;
  capturedAt: string | null;
  metadata: Record<string, unknown>;
  /** False when capture_type is outside RECOGNIZED_CAPTURE_TYPES -- recorded, never rejected. */
  captureTypeRecognized: boolean;
  /** Set when captured_at was present but unusable; the capture is still accepted. */
  capturedAtWarning: string | null;
  /** Set when unstorable control characters were removed from the content. */
  contentWarning: string | null;
};

export type CaptureValidationResult =
  | { ok: true; value: CaptureRequest }
  | { ok: false; error: string };

/*
 * Postgres text cannot hold a NUL byte at all -- an insert containing one
 * fails with "unsupported Unicode escape sequence" -- and the other C0
 * control characters are display noise a clipboard picks up rather than
 * anything a person typed. Found the hard way: a capture containing \u0000
 * not only 500'd, it took its own diagnostic trace down with it, because the
 * trace summary quoted the content and hit the same restriction. So the
 * capture became both lost AND invisible, which is the one outcome this
 * system exists to prevent.
 *
 * Stripping is the right call over rejecting: the byte is unstorable, but the
 * sentence around it is exactly what Dave meant to save.
 */
const UNSTORABLE_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function stripUnstorableCharacters(value: string): string {
  return value.replace(UNSTORABLE_CHARACTERS, "");
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Accepts snake_case (the documented contract, and what a Drafts template
 * produces) as well as camelCase, because half the clients calling this will
 * be hand-written JavaScript and a capture lost to a naming convention is
 * still a capture lost.
 */
function field(raw: Record<string, unknown>, snake: string, camel: string): unknown {
  return raw[snake] !== undefined ? raw[snake] : raw[camel];
}

export function isCaptureSource(value: unknown): value is CaptureSource {
  return typeof value === "string" && (CAPTURE_SOURCES as readonly string[]).includes(value);
}

export function isRecognizedCaptureType(value: string): boolean {
  return (RECOGNIZED_CAPTURE_TYPES as readonly string[]).includes(value);
}

export function validateCaptureRequest(body: unknown): CaptureValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const raw = body as Record<string, unknown>;

  const rawContent = field(raw, "content", "content");
  if (typeof rawContent !== "string") {
    return { ok: false, error: "content is required and must be a string." };
  }
  const content = stripUnstorableCharacters(rawContent).trim();
  const contentWarning =
    content.length !== rawContent.trim().length
      ? "Control characters that Postgres cannot store were removed from the content."
      : null;
  if (content.length === 0) {
    return { ok: false, error: "content must not be blank." };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      ok: false,
      error: `content is ${content.length} characters; the limit is ${MAX_CONTENT_LENGTH}.`,
    };
  }

  const rawSource = str(field(raw, "source", "source")) ?? "other";
  if (!isCaptureSource(rawSource)) {
    return { ok: false, error: `source must be one of: ${CAPTURE_SOURCES.join(", ")}` };
  }

  const captureTypeInput = str(field(raw, "capture_type", "captureType")) ?? DEFAULT_CAPTURE_TYPE;
  if (captureTypeInput.length > MAX_CAPTURE_TYPE_LENGTH) {
    return {
      ok: false,
      error: `capture_type is ${captureTypeInput.length} characters; the limit is ${MAX_CAPTURE_TYPE_LENGTH}.`,
    };
  }
  // Normalized, not validated: "Quick Add Task" and "quick_add_task" are the
  // same intent typed by the same person on two different devices.
  const captureType = captureTypeInput.toLowerCase().replace(/[\s-]+/g, "_");

  const sourceExternalId = str(
    field(raw, "source_external_id", "sourceExternalId") ??
      // Drafts' own field name, accepted directly so the documented Drafts
      // template does not need a translation step.
      (raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>).draft_uuid
        : undefined)
  );
  if (sourceExternalId && sourceExternalId.length > MAX_EXTERNAL_ID_LENGTH) {
    return {
      ok: false,
      error: `source_external_id is ${sourceExternalId.length} characters; the limit is ${MAX_EXTERNAL_ID_LENGTH}.`,
    };
  }

  /*
   * A bad timestamp is a warning, not a rejection. The client clock is the
   * least trustworthy thing in the payload and the least important: Proxy
   * stamps received_at itself, so an unusable captured_at costs ordering
   * precision, never the capture.
   */
  let capturedAt: string | null = null;
  let capturedAtWarning: string | null = null;
  const rawCapturedAt = str(field(raw, "captured_at", "capturedAt"));
  if (rawCapturedAt) {
    const parsed = Date.parse(rawCapturedAt);
    if (Number.isNaN(parsed)) {
      capturedAtWarning = `captured_at "${rawCapturedAt}" is not an ISO 8601 timestamp; it was ignored.`;
    } else {
      capturedAt = new Date(parsed).toISOString();
    }
  }

  const rawMetadata = field(raw, "metadata", "metadata");
  const metadata =
    rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? (rawMetadata as Record<string, unknown>)
      : {};

  return {
    ok: true,
    value: {
      source: rawSource,
      captureType,
      content,
      sourceExternalId,
      capturedAt,
      metadata,
      captureTypeRecognized: isRecognizedCaptureType(captureType),
      capturedAtWarning,
      contentWarning,
    },
  };
}

/**
 * A short, human-readable stand-in for the capture in trace summaries and
 * Inspector General rows. Never the storage form -- `content` is stored whole
 * and untouched; this only exists so a 4,000-word ramble does not become a
 * 4,000-word trace summary.
 */
export function capturePreview(content: string, max = 120): string {
  // Stripped here too, independently of the content path: this string goes
  // into a diagnostic trace summary, and a trace that cannot be written is
  // how a failure becomes invisible.
  const collapsed = stripUnstorableCharacters(content).replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
