import test from "node:test";
import assert from "node:assert/strict";
import {
  planSubmissionReconciliation,
  categoryFromLabel,
  actionFromLabel,
} from "./src/lib/mailroom/submissionReconciliation.ts";

const AT = "2026-08-30T12:00:00.000Z";

function proposal(overrides = {}) {
  return {
    mailroomConversationId: "conv-uuid",
    category: "fyi",
    requestedAction: "archive",
    recommendedAction: "archive",
    suggestedReply: "Thanks, noted.",
    isMeetingInvitation: false,
    ...overrides,
  };
}

function reviewed(overrides = {}) {
  return {
    bucketLabel: "FYI",
    requestedActionLabel: "Archive",
    humanReplyEdit: null,
    humanInstruction: null,
    submitted: true,
    ...overrides,
  };
}

test("label maps cover every bucket and action", () => {
  assert.equal(categoryFromLabel("Professional News"), "professional_news");
  assert.equal(categoryFromLabel("Workday"), "workday");
  assert.equal(categoryFromLabel("Calendar"), "calendar");
  assert.equal(actionFromLabel("Accept Invite"), "accept_invite");
  assert.equal(actionFromLabel("Needs Attention"), "needs_attention");
  assert.equal(categoryFromLabel("Nonsense"), null);
});

test("an unsubmitted row is refused", () => {
  const plan = planSubmissionReconciliation(proposal(), reviewed({ submitted: false }), AT);
  assert.match(plan.rejected, /not marked Submitted/);
  assert.deepEqual(plan.corrections, []);
});

test("endorsing Proxy's proposal records NO correction", () => {
  const plan = planSubmissionReconciliation(proposal(), reviewed(), AT);
  assert.equal(plan.rejected, null);
  assert.deepEqual(plan.changedFields, []);
  assert.deepEqual(plan.corrections, []);
  assert.equal(plan.conversationPatch.review_state, "submitted");
  assert.equal(plan.conversationPatch.submitted_at, AT);
  // Provenance must NOT become "notion" when nothing was chosen there.
  assert.equal("selected_action_source" in plan.conversationPatch, false);
});

test("a corrected bucket preserves BOTH the original and the reviewed value", () => {
  const plan = planSubmissionReconciliation(proposal(), reviewed({ bucketLabel: "Needs You" }), AT);
  assert.deepEqual(plan.changedFields, ["category"]);
  assert.equal(plan.conversationPatch.category, "needs_you");
  const [correction] = plan.corrections;
  assert.equal(correction.original_category, "fyi");
  assert.equal(correction.corrected_category, "needs_you");
  assert.equal(correction.feedback_source, "notion");
});

test("a corrected action records the RECOMMENDED action as the original", () => {
  const plan = planSubmissionReconciliation(
    proposal({ recommendedAction: "archive", requestedAction: "archive" }),
    reviewed({ requestedActionLabel: "Draft Reply" }),
    AT
  );
  assert.deepEqual(plan.changedFields, ["requested_action"]);
  assert.equal(plan.conversationPatch.requested_action, "draft_reply");
  assert.equal(plan.conversationPatch.selected_action_source, "notion");
  assert.equal(plan.corrections[0].original_action, "archive");
  assert.equal(plan.corrections[0].corrected_action, "draft_reply");
});

test("a human reply edit preserves Proxy's original suggested reply", () => {
  const plan = planSubmissionReconciliation(
    proposal(),
    reviewed({ humanReplyEdit: "Actually, let's meet Tuesday." }),
    AT
  );
  assert.deepEqual(plan.changedFields, ["human_reply_edit"]);
  const [correction] = plan.corrections;
  assert.equal(correction.original_suggested_reply, "Thanks, noted.");
  assert.equal(correction.corrected_reply, "Actually, let's meet Tuesday.");
});

test("free-text instruction is captured as feedback_text", () => {
  const plan = planSubmissionReconciliation(
    proposal(),
    reviewed({ humanInstruction: "Never archive mail from the Provost." }),
    AT
  );
  assert.equal(plan.corrections[0].feedback_text, "Never archive mail from the Provost.");
});

test("whitespace-only human fields count as no edit", () => {
  const plan = planSubmissionReconciliation(proposal(), reviewed({ humanReplyEdit: "   ", humanInstruction: "\n" }), AT);
  assert.deepEqual(plan.changedFields, []);
  assert.deepEqual(plan.corrections, []);
});

test("SAFETY GATE: Accept Invite is refused on a non-invitation even if a human picked it", () => {
  const plan = planSubmissionReconciliation(
    proposal({ isMeetingInvitation: false }),
    reviewed({ requestedActionLabel: "Accept Invite" }),
    AT
  );
  assert.match(plan.rejected, /positively identified meeting invitation/);
  assert.deepEqual(plan.conversationPatch, {});
});

test("Accept Invite is allowed on a positively identified invitation", () => {
  const plan = planSubmissionReconciliation(
    proposal({ isMeetingInvitation: true, category: "calendar", requestedAction: "archive" }),
    reviewed({ bucketLabel: "Calendar", requestedActionLabel: "Accept Invite" }),
    AT
  );
  assert.equal(plan.rejected, null);
  assert.equal(plan.conversationPatch.requested_action, "accept_invite");
});

test("unrecognized Notion values are refused rather than silently coerced", () => {
  assert.match(
    planSubmissionReconciliation(proposal(), reviewed({ bucketLabel: "Someday" }), AT).rejected,
    /Unrecognized Bucket/
  );
  assert.match(
    planSubmissionReconciliation(proposal(), reviewed({ requestedActionLabel: "Delete Forever" }), AT).rejected,
    /Unrecognized Requested Action/
  );
});

test("a cleared Notion select falls back to Proxy's value instead of nulling it", () => {
  const plan = planSubmissionReconciliation(
    proposal({ category: "workday", requestedAction: "archive" }),
    reviewed({ bucketLabel: null, requestedActionLabel: null }),
    AT
  );
  assert.equal(plan.conversationPatch.category, "workday");
  assert.equal(plan.conversationPatch.requested_action, "archive");
  assert.deepEqual(plan.corrections, []);
});

test("multiple simultaneous corrections collapse into ONE evidence record", () => {
  const plan = planSubmissionReconciliation(
    proposal(),
    reviewed({
      bucketLabel: "Needs You",
      requestedActionLabel: "Draft Reply",
      humanReplyEdit: "Rewritten.",
      humanInstruction: "This sender always matters.",
    }),
    AT
  );
  assert.deepEqual(plan.changedFields, ["category", "requested_action", "human_reply_edit", "human_instruction"]);
  assert.equal(plan.corrections.length, 1, "one human decision must not become several evidence rows");
});

test("submission never produces an execution instruction", () => {
  const plan = planSubmissionReconciliation(
    proposal({ isMeetingInvitation: true }),
    reviewed({ requestedActionLabel: "Accept Invite" }),
    AT
  );
  // Review state only -- nothing here arms Power Automate.
  assert.equal("execution_status" in plan.conversationPatch, false);
  assert.equal(plan.conversationPatch.review_state, "submitted");
});
