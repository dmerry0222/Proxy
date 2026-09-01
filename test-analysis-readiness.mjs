import test from "node:test";
import assert from "node:assert/strict";
import { hasCurrentMailroomAnalysis } from "./src/lib/mailroom/analysisReadiness.ts";

test("never analyzed -- no stored analysis at all", () => {
  assert.equal(
    hasCurrentMailroomAnalysis({
      mailroomConversationId: null,
      analysisMessageId: null,
      currentMessageId: "msg-1",
    }),
    false
  );
});

test("current -- stored analysis message id matches the live thread's latest message", () => {
  assert.equal(
    hasCurrentMailroomAnalysis({
      mailroomConversationId: "conv-uuid-1",
      analysisMessageId: "msg-1",
      currentMessageId: "msg-1",
    }),
    true
  );
});

test("stale -- a newer message has arrived since the stored analysis", () => {
  assert.equal(
    hasCurrentMailroomAnalysis({
      mailroomConversationId: "conv-uuid-1",
      analysisMessageId: "msg-1",
      currentMessageId: "msg-2",
    }),
    false
  );
});

test("defensive: analysis message id present but no mailroom_conversations id is never current", () => {
  assert.equal(
    hasCurrentMailroomAnalysis({
      mailroomConversationId: null,
      analysisMessageId: "msg-1",
      currentMessageId: "msg-1",
    }),
    false
  );
});
