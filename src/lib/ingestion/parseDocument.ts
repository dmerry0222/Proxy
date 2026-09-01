import type {
  ParsedDocument,
  ParsedFrontmatter,
  ParsedSection,
} from "@/lib/ingestion/types";

/*
 * `pdf-parse` and `mammoth` are loaded LAZILY, inside the branch that
 * actually needs them -- never at module scope.
 *
 * This is not a micro-optimization. `pdf-parse` re-exports
 * `pdfjs-dist/legacy/build/pdf.mjs`, which at MODULE SCOPE evaluates
 * `const SCALE_MATRIX = new DOMMatrix();`. In Node, `DOMMatrix` is not a
 * global; pdfjs tries to polyfill it by `require`ing the native
 * `@napi-rs/canvas` addon, and when that require fails it merely warns --
 * then throws `ReferenceError: DOMMatrix is not defined` a few lines
 * later. Bundled into a Vercel serverless function, the native addon is
 * not reliably resolvable, so the import threw during module evaluation
 * and took the whole route down before its request handler ever ran
 * (a ~11ms failure with no outbound calls, and an empty 500 that the
 * route's own try/catch could not intercept).
 *
 * Static imports made every Markdown/text/JSON artifact pay that risk for
 * a parser it never calls. Deferring the import means text ingestion never
 * touches pdfjs at all, and a genuine PDF failure surfaces as a catchable
 * rejection with a useful stage instead of a dead function.
 *
 * See also `serverExternalPackages` in next.config.ts, which keeps
 * pdf-parse/pdfjs-dist/@napi-rs/canvas out of the bundle so the native
 * addon resolves normally at runtime when a PDF really does arrive.
 */

/** Carries the pipeline stage that failed, so callers can report where it broke. */
export class DocumentParseError extends Error {
  readonly stage: string;

  constructor(stage: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentParseError";
    this.stage = stage;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/vtt",
  "application/json",
]);

function parseScalar(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized === "null") return null;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return normalized.replace(/^['"]|['"]$/g, "");
}

function extractFrontmatter(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {} as ParsedFrontmatter, body: text, bodyStartLine: 1 };
  }

  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) {
    return { frontmatter: {} as ParsedFrontmatter, body: text, bodyStartLine: 1 };
  }

  const end = closingIndex + 1;
  const frontmatter: ParsedFrontmatter = {};
  let activeArrayKey: string | null = null;

  for (const line of lines.slice(1, end)) {
    const arrayItem = line.match(/^\s*-\s+(.+)$/);
    if (arrayItem && activeArrayKey) {
      const existing = frontmatter[activeArrayKey];
      frontmatter[activeArrayKey] = [
        ...(Array.isArray(existing) ? existing : []),
        String(parseScalar(arrayItem[1]) ?? ""),
      ];
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (!rawValue.trim()) {
      frontmatter[key] = [];
      activeArrayKey = key;
    } else {
      frontmatter[key] = parseScalar(rawValue);
      activeArrayKey = null;
    }
  }

  return {
    frontmatter,
    body: lines.slice(end + 1).join("\n").trim(),
    bodyStartLine: end + 2,
  };
}

function classifyHeading(heading: string) {
  const value = heading.toLowerCase();
  if (/next steps?|action items?|to-?do/.test(value)) return "next_steps";
  if (/decision/.test(value)) return "decisions";
  if (/open questions?|questions?/.test(value)) return "open_questions";
  if (/risk|blocker/.test(value)) return "risks";
  if (/summary|overview/.test(value)) return "summary";
  if (/agenda/.test(value)) return "agenda";
  return "body";
}

function sectionMarkdown(text: string, lineOffset: number): ParsedSection[] {
  const lines = text.split("\n");
  const sections: ParsedSection[] = [];
  let heading: string | null = null;
  let start = 0;

  function push(end: number) {
    const content = lines.slice(start, end).join("\n").trim();
    if (!content) return;
    sections.push({
      ordinal: sections.length,
      sectionType: heading ? classifyHeading(heading) : "body",
      heading,
      content,
      startLine: lineOffset + start,
      endLine: lineOffset + end - 1,
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    push(index);
    heading = match[1].trim();
    start = index + 1;
  }
  push(lines.length);

  if (sections.length === 0 && text.trim()) {
    sections.push({ ordinal: 0, sectionType: "body", heading: null,
      content: text.trim(), startLine: lineOffset, endLine: lineOffset + lines.length - 1 });
  }
  return sections;
}

export async function parseDocument(bytes: Uint8Array, mimeType: string): Promise<ParsedDocument> {
  let sourceText: string;
  let parserName: string;

  if (mimeType === "application/pdf") {
    /*
     * Deliberately two separate try/catches: a failure to LOAD the parser
     * (missing native canvas addon, DOMMatrix) is an environment problem,
     * while a failure to READ the document is a bad-input problem. They
     * want different stages because they need different responses --
     * redeploy vs. reject the file.
     */
    let PDFParse: typeof import("pdf-parse").PDFParse;
    try {
      ({ PDFParse } = await import("pdf-parse"));
    } catch (error) {
      throw new DocumentParseError(
        "load_pdf_parser",
        `PDF parsing is unavailable in this runtime: ${describe(error)}`,
        { cause: error },
      );
    }

    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      sourceText = result.text;
      parserName = "pdf_parse_v1";
    } catch (error) {
      throw new DocumentParseError("parse_pdf", `Could not read the PDF: ${describe(error)}`, { cause: error });
    } finally {
      await parser.destroy();
    }
  } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    let mammoth: typeof import("mammoth");
    try {
      mammoth = (await import("mammoth")).default;
    } catch (error) {
      throw new DocumentParseError(
        "load_docx_parser",
        `DOCX parsing is unavailable in this runtime: ${describe(error)}`,
        { cause: error },
      );
    }

    try {
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      sourceText = result.value;
      parserName = "mammoth_raw_text_v1";
    } catch (error) {
      throw new DocumentParseError("parse_docx", `Could not read the Word document: ${describe(error)}`, { cause: error });
    }
  } else if (TEXT_MIME_TYPES.has(mimeType)) {
    // No parser library is loaded on this path at all -- this is the
    // Markdown/text/JSON route that was previously crashing on pdfjs.
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (mimeType === "application/json") {
      try {
        sourceText = JSON.stringify(JSON.parse(decoded), null, 2);
      } catch (error) {
        throw new DocumentParseError("parse_json", `Attachment is not valid JSON: ${describe(error)}`, { cause: error });
      }
    } else {
      sourceText = decoded;
    }
    parserName = mimeType === "text/vtt" ? "vtt_text_v1" : "structured_text_v1";
  } else {
    return { supported: false, text: "", frontmatter: {}, sections: [], parserName: "stored_only", parserVersion: 1 };
  }

  const { frontmatter, body, bodyStartLine } = extractFrontmatter(sourceText);

  return {
    supported: true,
    text: body,
    frontmatter,
    sections: sectionMarkdown(body, bodyStartLine),
    parserName,
    parserVersion: 1,
  };
}
