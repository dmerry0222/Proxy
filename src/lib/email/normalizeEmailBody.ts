/**
 * Shared email-body cleaning for anything that reasons over email content
 * with an LLM -- Mailroom summaries, Memory extraction, Action
 * Reconciliation. Previously this logic was partial and split: Memory had
 * `stripQuotedReplyHistory` (quoted-reply stripping only, no banner
 * handling) and Mailroom had nothing at all -- it fed Graph's raw,
 * pre-truncated `body_preview` straight to Claude. For a short external
 * email, Suffolk's security banner can consume the ENTIRE preview, so
 * Mailroom's "summary" was often just the banner verbatim.
 *
 * NEVER mutates or replaces the canonical stored email (`emails.body_html`
 * / `emails.body_preview`). This module only produces a derived string for
 * feeding to AI -- callers must keep using the canonical fields for
 * anything that needs the real, original message.
 */

import { htmlToPlainText } from "../memory/htmlToPlainText.ts";

export type CleanedEmailBody = {
  /** The cleaned text to feed to summarization/extraction. Never the canonical body. */
  text: string;
  originalCharacterCount: number;
  cleanedCharacterCount: number;
  externalBannerRemoved: boolean;
  quotedHistoryRemoved: boolean;
  signatureRemoved: boolean;
};

/**
 * Cuts text off at the first quoted-reply/forward marker. Moved here from
 * ingestEmail.ts (previously Memory-only) so Mailroom shares the exact
 * same rule instead of re-implementing it. A forwarded message's inline
 * "From: ... Sent: ... To: ... Subject:" header block is also caught by
 * the `from:` marker, so this doubles as "duplicated wrapper/header junk"
 * removal without a separate pass.
 *
 * Leading `[ \t]*` on every marker: found via a real-data spot-check that
 * htmlToPlainText replaces every remaining tag with a SPACE (not empty
 * string), so an Outlook forward header nested in markup like
 * `</p><div><p><b><span>From:...` becomes `\n     From:...` -- a real
 * newline followed by a few spaces, not "From:" at true line-start. An
 * anchor requiring "From:" as the line's literal first characters silently
 * never matched this (very common) shape.
 */
const QUOTED_HISTORY_MARKERS: RegExp[] = [
  /^[ \t]*from:\s.+$/im,
  /^[ \t]*on .+ wrote:$/im,
  /^[ \t]*-{2,}\s*original message\s*-{2,}$/im,
  /^[ \t]*_{5,}$/m,
];

export function stripQuotedReplyHistory(text: string): string {
  let cutoff = text.length;
  for (const marker of QUOTED_HISTORY_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < cutoff) {
      cutoff = match.index;
    }
  }
  return text.slice(0, cutoff).trim();
}

/**
 * Institutional "this came from outside our organization" security banners.
 * Confidently detectable and near-universally boilerplate -- for a short
 * email these can dominate the entire visible preview, which is the exact
 * bug this module exists to fix. Anchored to the leading ~600 characters
 * of the message so a banner-shaped false positive deep in a long email
 * (extremely unlikely given the specificity of the wording) can't eat
 * later substantive content.
 */
const LEADING_WINDOW = 600;

const BANNER_PATTERNS: RegExp[] = [
  // Suffolk's exact banner, with tolerance for minor wording variation.
  /caution:\s*this email originated from outside[\s\S]{0,250}?(?:safe\.?|is safe)/i,
  // Generic equivalents seen across other institutions' mail gateways.
  /this (?:email|message) (?:originated|came) from an? (?:external|outside) (?:source|sender|address|the organization)[\s\S]{0,250}?(?:safe\.?|attachments)/i,
  /do not click (?:on )?links? or open attachments? unless you (?:recognize|know|trust)[\s\S]{0,150}?safe\.?/i,
];

// A short leading tag line, e.g. "[EXTERNAL]" / "[External Email]" /
// "[CAUTION: External Sender]" -- only matched as a standalone line at the
// very start of the message, never mid-paragraph.
const LEADING_TAG_PATTERN = /^\s*\[(?:external|caution|external email|external sender)[^\]\n]{0,40}\]\s*\n+/i;

function stripExternalBanner(text: string): { text: string; removed: boolean } {
  const window = text.slice(0, LEADING_WINDOW);
  const rest = text.slice(LEADING_WINDOW);

  let cleanedWindow = window;
  let removed = false;

  const tagMatch = LEADING_TAG_PATTERN.exec(cleanedWindow);
  if (tagMatch) {
    cleanedWindow = cleanedWindow.slice(tagMatch.index + tagMatch[0].length);
    removed = true;
  }

  for (const pattern of BANNER_PATTERNS) {
    const match = pattern.exec(cleanedWindow);
    if (match) {
      const before = cleanedWindow.slice(0, match.index);
      // The banner's own trailing period is optionally matched (some
      // variants omit it), which otherwise leaves an orphaned leading
      // "." on the real content -- strip any leftover punctuation/
      // whitespace at the cut point along with the match itself.
      const after = cleanedWindow.slice(match.index + match[0].length).replace(/^[\s.,;:]+/, "");
      cleanedWindow = before + after;
      removed = true;
    }
  }

  return { text: (cleanedWindow + rest).trim(), removed };
}

/**
 * Deliberately conservative: only the RFC 3676 signature delimiter
 * ("-- " alone on its own line) is treated as a signature boundary.
 * Heuristics like "cutting after 'Best regards,'" were considered and
 * rejected -- a sign-off phrase can appear mid-message ("Thanks for
 * your help on this") without being followed by an actual signature
 * block, and the task explicitly calls for avoiding aggressive stripping
 * of substantive text. The RFC delimiter has no such ambiguity.
 */
const SIGNATURE_DELIMITER = /^--\s*$/m;

function stripSignature(text: string): { text: string; removed: boolean } {
  const match = SIGNATURE_DELIMITER.exec(text);
  if (!match) return { text, removed: false };
  return { text: text.slice(0, match.index).trim(), removed: true };
}

/** Below this, stripping is considered to have over-cleaned the message; fall back to lighter cleaning. */
/*
 * Deliberately tiny: this guards against stripping collapsing a message to
 * EMPTY/near-empty, not against a legitimately short result. A genuinely
 * short real message (e.g. "Short reply." at 12 chars, once a long banner
 * is removed) is a valid, useful cleaned result and must not be reverted
 * just for being short -- found via a real-data spot-check where an
 * earlier, larger threshold (15) was undoing a correct banner strip on
 * exactly this kind of short substantive message.
 */
const MIN_SAFE_RESULT_LENGTH = 3;

/**
 * Produces the cleaned text an LLM should read for summarization/extraction,
 * from whichever canonical body fields are available. Prefers `bodyHtml`
 * (the full message) over `bodyPreview` (Graph's truncated plain-text
 * preview) since the preview is exactly what let a banner crowd out real
 * content in the first place.
 */
export function buildCleanedEmailBody(input: {
  bodyHtml: string | null | undefined;
  bodyPreview: string | null | undefined;
}): CleanedEmailBody {
  const raw = input.bodyHtml ? htmlToPlainText(input.bodyHtml) : (input.bodyPreview ?? "").trim();
  const originalCharacterCount = raw.length;

  const afterQuoted = stripQuotedReplyHistory(raw);
  const quotedHistoryRemoved = afterQuoted.length < raw.length;

  const afterBanner = stripExternalBanner(afterQuoted);
  const afterSignature = stripSignature(afterBanner.text);

  let finalText = afterSignature.text;

  // Safety valve: never let stripping collapse a substantive message down
  // to near-nothing. Fall back to the pre-banner/signature-stripped text
  // (still quoted-history-free) rather than risk feeding the model an
  // empty/near-empty string.
  if (finalText.length < MIN_SAFE_RESULT_LENGTH && afterQuoted.length >= MIN_SAFE_RESULT_LENGTH) {
    finalText = afterQuoted;
    return {
      text: finalText,
      originalCharacterCount,
      cleanedCharacterCount: finalText.length,
      externalBannerRemoved: false,
      quotedHistoryRemoved,
      signatureRemoved: false,
    };
  }

  return {
    text: finalText,
    originalCharacterCount,
    cleanedCharacterCount: finalText.length,
    externalBannerRemoved: afterBanner.removed,
    quotedHistoryRemoved,
    signatureRemoved: afterSignature.removed,
  };
}
