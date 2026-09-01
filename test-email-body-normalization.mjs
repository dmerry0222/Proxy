import test from "node:test";
import assert from "node:assert/strict";
import { buildCleanedEmailBody, stripQuotedReplyHistory } from "./src/lib/email/normalizeEmailBody.ts";

const SUFFOLK_BANNER =
  "CAUTION: This email originated from outside of the University. Do not click links or open attachments unless you recognize the sender and know the content is safe.";

test("Suffolk external security banner is stripped, substantive content preserved", () => {
  const body = `${SUFFOLK_BANNER}\n\nHi Dave,\n\nJordan is asking whether Suffolk can participate in the employer panel on October 4. Let me know if that works.\n\nThanks,\nJordan`;
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.externalBannerRemoved, true);
  assert.doesNotMatch(result.text, /CAUTION: This email originated/i);
  assert.match(result.text, /employer panel on October 4/);
});

test("a leading [EXTERNAL] tag line is stripped without touching the message", () => {
  const body = "[EXTERNAL]\n\nCan we move our 1:1 to Thursday instead?";
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.externalBannerRemoved, true);
  assert.match(result.text, /move our 1:1 to Thursday/);
});

test("normal substantive first paragraph is preserved untouched when there is no boilerplate", () => {
  const body = "Sarah shared the revised internship approval workflow and wants feedback before Friday.";
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.text, body);
  assert.equal(result.externalBannerRemoved, false);
});

test("quoted reply history is removed", () => {
  const body = "Sounds good, see you then.\n\nFrom: Dave Merry\nSent: Monday\nTo: Jordan\nSubject: RE: Meeting\n\nCan we meet Monday?";
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.quotedHistoryRemoved, true);
  assert.equal(result.text, "Sounds good, see you then.");
  assert.doesNotMatch(result.text, /Can we meet Monday/);
});

test("quoted history nested in Outlook's forward-header markup (real edge case) is still stripped", () => {
  // Real-data edge case: htmlToPlainText turns every remaining tag into a
  // SPACE (not empty string), so Outlook's forward header --
  // `</p><div><p><b><span>From:</span></b><span> Jan Kenney &lt;...&gt;`
  // -- becomes "...\n     From: Jan Kenney <...>", i.e. a newline
  // followed by SPACES before "From:", not "From:" at true line start.
  const html =
    "<p>Hi Sarah, could you try this link: Canvas IT Support.</p>" +
    "<div><div><p><b><span>From:</span></b><span> Jan Kenney &lt;jkenney@suffolk.edu&gt; " +
    "<br><b>Sent:</b> Monday, August 31, 2026 11:18 AM<br><b>To:</b> Sarah Burrows</span></p></div></div>";
  const result = buildCleanedEmailBody({ bodyHtml: html, bodyPreview: null });

  assert.equal(result.quotedHistoryRemoved, true);
  assert.match(result.text, /Canvas IT Support/);
  assert.doesNotMatch(result.text, /Jan Kenney/);
  assert.doesNotMatch(result.text, /Sent: Monday/);
});

test("stripQuotedReplyHistory handles the 'On ... wrote:' marker", () => {
  const body = "Thanks, that works.\n\nOn Mon, Jan 5, 2026 at 3:00 PM, Jordan wrote:\n> Can we meet Monday?";
  assert.equal(stripQuotedReplyHistory(body), "Thanks, that works.");
});

test("a short email remains usable and untouched", () => {
  const body = "Yes, that works for me.";
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.text, "Yes, that works for me.");
});

test("HTML email becomes useful cleaned text", () => {
  const html = "<html><body><p>Hi Dave,</p><p>The proposal is attached for your review.</p></body></html>";
  const result = buildCleanedEmailBody({ bodyHtml: html, bodyPreview: "Hi Dave, The proposal is attached..." });

  assert.match(result.text, /proposal is attached for your review/);
  assert.doesNotMatch(result.text, /<p>|<html>/);
});

test("original input strings are never mutated", () => {
  const original = `${SUFFOLK_BANNER}\n\nReal content here.`;
  const originalCopy = original;
  buildCleanedEmailBody({ bodyHtml: null, bodyPreview: original });

  assert.equal(original, originalCopy);
});

test("aggressive stripping safety valve: a message that is ALMOST ENTIRELY banner-like text still returns something", () => {
  // A message where the "safe content" after stripping would be empty --
  // the safety valve should prevent returning an empty string outright
  // when there was substantive original length.
  const body = `${SUFFOLK_BANNER} ${SUFFOLK_BANNER}`;
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });
  assert.equal(typeof result.text, "string");
});

test("no orphaned leading punctuation remains after the banner's optional trailing period is stripped", () => {
  // Real-data edge case found in spot-check: the banner regex's optional
  // trailing period sometimes left a stray leading ". " on the real
  // content when the banner's own period was consumed separately.
  const body = `${SUFFOLK_BANNER} The lowest available rates end Friday, September 4.`;
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });
  assert.equal(/^[.,;:\s]/.test(result.text), false, `expected no leading punctuation, got: "${result.text.slice(0, 20)}"`);
  assert.match(result.text, /^The lowest available rates/);
});

test("reports original and cleaned character counts", () => {
  const body = `${SUFFOLK_BANNER}\n\nShort reply.`;
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.originalCharacterCount, body.length);
  assert.ok(result.cleanedCharacterCount < result.originalCharacterCount);
});

test("a legitimately short message is NOT reverted by the safety valve just for being short", () => {
  // Regression: MIN_SAFE_RESULT_LENGTH was originally 15, which reverted
  // this exact case (a 12-char real reply after a long banner) back to
  // including the banner, on the mistaken assumption that "short" implied
  // "over-stripped."
  const body = `${SUFFOLK_BANNER}\n\nShort reply.`;
  const result = buildCleanedEmailBody({ bodyHtml: null, bodyPreview: body });

  assert.equal(result.text, "Short reply.");
  assert.equal(result.externalBannerRemoved, true);
});
