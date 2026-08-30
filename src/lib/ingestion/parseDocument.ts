import type {
  ParsedDocument,
  ParsedFrontmatter,
  ParsedSection,
} from "@/lib/ingestion/types";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

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
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      sourceText = result.text;
      parserName = "pdf_parse_v1";
    } finally {
      await parser.destroy();
    }
  } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    sourceText = result.value;
    parserName = "mammoth_raw_text_v1";
  } else if (TEXT_MIME_TYPES.has(mimeType)) {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    sourceText = mimeType === "application/json"
      ? JSON.stringify(JSON.parse(decoded), null, 2)
      : decoded;
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
