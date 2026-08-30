/**
 * Validation and normalization for the external (machine-to-machine)
 * artifact ingestion payload. Pure, zero-import leaf module so every
 * rejection rule is unit testable without a live request, a database, or
 * Power Automate.
 *
 * This is the trust boundary. The body arrives from a cloud flow with no
 * schema enforcement of its own, so everything is treated as unknown until
 * proven otherwise -- an absent field becomes a documented default, and a
 * malformed one becomes a 400 with a reason a flow author can act on,
 * never a silent coercion that ingests a corrupt artifact.
 */

/* Keep in sync with ArtifactType / ArtifactContextHint in types.ts.
 * Duplicated rather than imported to keep this module import-free. */
const ARTIFACT_TYPES = [
  "transcript",
  "summary",
  "personal_notes",
  "agenda",
  "chat_export",
  "recording",
  "attachment",
  "other",
];
const CONTEXT_HINTS = ["auto", "general", "meeting"];

/**
 * Decoded-size ceiling. Note this is NOT the binding limit in production:
 * Vercel rejects request bodies over ~4.5 MB before this code runs, and
 * base64 inflates payloads by ~33%, so the practical attachment ceiling is
 * ~3.3 MB. This exists so a non-Vercel deployment still has a bound, and so
 * the failure is a clear 413 rather than an out-of-memory.
 */
export const MAX_DECODED_BYTES = 25 * 1024 * 1024;

export type ExternalArtifactRequest = {
  sourceSystem: string;
  artifactType: string;
  contextHint: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
  title: string | null;
  occurredAt: string | null;
  outlookMessageId: string | null;
  internetMessageId: string | null;
  emailSubject: string | null;
  sender: string | null;
  attachmentId: string | null;
};

export type ValidationResult =
  | { ok: true; value: ExternalArtifactRequest }
  | { ok: false; error: string };

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Extension -> mime, for the types Outlook meeting notes actually arrive as. */
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  vtt: "text/vtt",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  csv: "text/csv",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
};

export function mimeTypeForFilename(filename: string): string {
  const extension = filename.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  return (extension && MIME_BY_EXTENSION[extension]) || "application/octet-stream";
}

export function validateExternalArtifactRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const raw = body as Record<string, unknown>;

  const filename = str(raw.filename);
  if (!filename) return { ok: false, error: "filename is required." };

  const contentBase64 = str(raw.contentBase64);
  if (!contentBase64) return { ok: false, error: "contentBase64 is required and must be a non-empty string." };

  // Defaults match the documented Power Automate use case, but every one of
  // them is overridable so this endpoint is not silently single-purpose.
  const sourceSystem = str(raw.sourceSystem) ?? "outlook";
  const artifactType = str(raw.artifactType) ?? "attachment";
  const contextHint = str(raw.contextHint) ?? "auto";

  if (!ARTIFACT_TYPES.includes(artifactType)) {
    return { ok: false, error: `artifactType must be one of: ${ARTIFACT_TYPES.join(", ")}` };
  }
  if (!CONTEXT_HINTS.includes(contextHint)) {
    return { ok: false, error: `contextHint must be one of: ${CONTEXT_HINTS.join(", ")}` };
  }

  const occurredAt = str(raw.occurredAt);
  if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) {
    return { ok: false, error: "occurredAt must be an ISO 8601 timestamp." };
  }

  return {
    ok: true,
    value: {
      sourceSystem,
      artifactType,
      contextHint,
      filename,
      mimeType: str(raw.mimeType) ?? mimeTypeForFilename(filename),
      contentBase64,
      title: str(raw.title),
      occurredAt,
      outlookMessageId: str(raw.outlookMessageId),
      internetMessageId: str(raw.internetMessageId),
      emailSubject: str(raw.emailSubject),
      sender: str(raw.sender),
      attachmentId: str(raw.attachmentId),
    },
  };
}

/**
 * The idempotency key for an externally-ingested attachment.
 *
 * `internetMessageId` (RFC 5322 Message-ID) is preferred over the Graph
 * message id for the same reason the Mailroom command identity prefers it:
 * the Graph/EWS id CHANGES when a message moves folders, and a Power
 * Automate flow that ingests an attachment and then files the mail would
 * produce a different id on retry -- silently creating a duplicate
 * artifact, which is precisely what this key exists to prevent.
 *
 * Returns null when there is nothing stable to key on. That is not an
 * error: ingestArtifact still deduplicates on content hash, so the caller
 * degrades to content-level idempotency rather than losing it entirely.
 */
export function externalArtifactIdentity(input: {
  internetMessageId: string | null;
  outlookMessageId: string | null;
  attachmentId: string | null;
}): string | null {
  const messageIdentity = input.internetMessageId ?? input.outlookMessageId;
  if (!messageIdentity || !input.attachmentId) return null;
  return `${messageIdentity}:${input.attachmentId}`;
}

export type DecodeResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

/**
 * Strict base64 decode. Buffer.from(..., "base64") silently ignores invalid
 * characters, so a corrupted payload would decode to plausible-looking
 * garbage and be ingested as a real artifact. Validating the shape first
 * turns that into an explicit 400.
 */
export function decodeBase64Content(raw: string, maxBytes: number = MAX_DECODED_BYTES): DecodeResult {
  // Power Automate may wrap long base64 in newlines, and some connectors
  // hand back a full data URI rather than bare base64.
  const withoutDataUri = raw.replace(/^data:[^;,]*;base64,/, "");
  const compact = withoutDataUri.replace(/\s+/g, "");

  if (compact.length === 0) return { ok: false, error: "contentBase64 decoded to an empty payload." };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { ok: false, error: "contentBase64 is not valid base64." };
  }

  const buffer = Buffer.from(compact, "base64");
  if (buffer.length === 0) return { ok: false, error: "contentBase64 decoded to an empty payload." };
  if (buffer.length > maxBytes) {
    return { ok: false, error: `Decoded content is ${buffer.length} bytes; the limit is ${maxBytes} bytes.` };
  }

  return { ok: true, bytes: new Uint8Array(buffer) };
}
