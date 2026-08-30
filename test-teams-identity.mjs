import test from "node:test";
import assert from "node:assert/strict";
import { deterministicCounterpart } from "./src/lib/reconciliation/teamsIdentity.ts";

const dave = { entityId: "dave-1", email: "dmerry@suffolk.edu", name: "Dave Merry" };
const sarah = { entityId: "sarah-1", email: "sarah@example.com", name: "Sarah" };
const aki = { entityId: "aki-1", email: "aki@example.com", name: "Aki" };

const daveMsg = (index) => ({ index, speakerActor: dave, isDave: true });
const sarahMsg = (index) => ({ index, speakerActor: sarah, isDave: false });
const akiMsg = (index) => ({ index, speakerActor: aki, isDave: false });
const unresolvedMsg = (index) => ({ index, speakerActor: null, isDave: false });

test("dave_owned: requester is the non-Dave speaker who asked", () => {
  const cited = [sarahMsg(1), daveMsg(2)];
  assert.deepEqual(deterministicCounterpart("dave_owned", cited), sarah);
});
test("dave_owned: requester is derived correctly regardless of citation order", () => {
  const cited = [daveMsg(2), sarahMsg(1)];
  assert.deepEqual(deterministicCounterpart("dave_owned", cited), sarah);
});
test("dave_owned: self-initiated with no requester leaves counterpart unresolved", () => {
  const cited = [daveMsg(1)];
  assert.equal(deterministicCounterpart("dave_owned", cited), null);
});
test("external_owned: counterpart is whoever authored the commitment", () => {
  const cited = [akiMsg(1)];
  assert.deepEqual(deterministicCounterpart("external_owned", cited), aki);
});
test("completion: counterpart is the most recent non-Dave speaker among cited messages", () => {
  const cited = [sarahMsg(1), akiMsg(2)];
  assert.deepEqual(deterministicCounterpart("completion", cited), aki);
});
test("cancellation: counterpart is derivable the same way as completion", () => {
  const cited = [akiMsg(1)];
  assert.deepEqual(deterministicCounterpart("cancellation", cited), aki);
});
test("ambiguous actor (unresolved speaker) is never fabricated", () => {
  const cited = [unresolvedMsg(1), daveMsg(2)];
  assert.equal(deterministicCounterpart("dave_owned", cited), null);
});
test("all-Dave citation with no other party leaves external_owned unresolved", () => {
  const cited = [daveMsg(1)];
  assert.equal(deterministicCounterpart("external_owned", cited), null);
});
test("unknown kind returns null rather than guessing", () => {
  const cited = [sarahMsg(1)];
  assert.equal(deterministicCounterpart("something_else", cited), null);
});
