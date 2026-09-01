import test from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyAutomatedSenderAddress,
  isSelfAddress,
  classifyUnresolvedSenderDiagnostic,
} from "./src/lib/memory/externalSenderAddressRules.ts";

test("obvious no-reply/system addresses are flagged as automated", () => {
  assert.equal(isLikelyAutomatedSenderAddress("no-reply@zoom.us"), true);
  assert.equal(isLikelyAutomatedSenderAddress("noreply@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("do-not-reply@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("donotreply@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("notifications@instructure.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("mailer-daemon@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("postmaster@example.com"), true);
});

test("common role/functional-mailbox local parts are flagged as automated", () => {
  assert.equal(isLikelyAutomatedSenderAddress("support@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("info@example.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("events@ci.chronicle.com"), true);
  assert.equal(isLikelyAutomatedSenderAddress("careers@example.com"), true);
});

test("a real person's local part that merely starts with a keyword is NOT flagged", () => {
  // "newsome" starts with "news" but isn't the automated token itself.
  assert.equal(isLikelyAutomatedSenderAddress("newsome@example.com"), false);
  assert.equal(isLikelyAutomatedSenderAddress("helpdeskmanager@example.com"), false);
  assert.equal(isLikelyAutomatedSenderAddress("infocenter@example.com"), false);
});

test("ordinary personal/professional addresses are not flagged", () => {
  assert.equal(isLikelyAutomatedSenderAddress("stazinskir@gmail.com"), false);
  assert.equal(isLikelyAutomatedSenderAddress("hailey@suitable.co"), false);
  assert.equal(isLikelyAutomatedSenderAddress("yigal@mit.edu"), false);
  assert.equal(isLikelyAutomatedSenderAddress("jordan.smith@example.com"), false);
});

test("Dave's own addresses are recognized as self, never an external correspondent", () => {
  assert.equal(isSelfAddress("dmerry@suffolk.edu"), true);
  assert.equal(isSelfAddress("dave.l.merry@gmail.com"), true);
  assert.equal(isSelfAddress("someoneelse@suffolk.edu"), false);
});

test("IG: an unresolved external sender is success/info, not a warning", () => {
  const result = classifyUnresolvedSenderDiagnostic("jordan@example.com");
  assert.equal(result.status, "success");
  assert.equal(result.severity, "info");
  assert.equal(result.isSuffolkSender, false);
});

test("IG: an unresolved automated external sender is also success/info", () => {
  const result = classifyUnresolvedSenderDiagnostic("no-reply@zoom.us");
  assert.equal(result.status, "success");
  assert.equal(result.severity, "info");
  assert.equal(result.likelyAutomated, true);
});

test("IG: repeated unresolved external senders always classify the same way (no escalation over time)", () => {
  const first = classifyUnresolvedSenderDiagnostic("jordan@example.com");
  const tenth = classifyUnresolvedSenderDiagnostic("jordan@example.com");
  assert.deepEqual(first, tenth);
  assert.equal(tenth.status, "success");
});

test("IG: an unresolved Suffolk sender that failed org-chart matching is a warning", () => {
  const result = classifyUnresolvedSenderDiagnostic("someunknownstaffer@suffolk.edu");
  assert.equal(result.status, "warning");
  assert.equal(result.severity, "warning");
  assert.equal(result.isSuffolkSender, true);
});
