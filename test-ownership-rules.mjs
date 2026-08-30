import test from "node:test";
import assert from "node:assert/strict";
import { gatesDaveOwnership, gatesExternalOwnership } from "./src/lib/reconciliation/ownershipRules.ts";

const daveEntity = { entityId: "person-1", email: "aki@example.com", name: "Aki" };
const noEntity = { entityId: null, email: null, name: null };

test("explicit assignment to Dave creates a candidate", () => {
  assert.equal(
    gatesDaveOwnership({ owner: "dave", basis: "explicit_assignment_to_dave", excerpt: "Dave, can you send this by Tuesday?" }),
    true
  );
});
test("explicit acceptance by Dave creates a candidate", () => {
  assert.equal(
    gatesDaveOwnership({ owner: "dave", basis: "explicit_acceptance_by_dave", excerpt: "Sure, I'll take care of it." }),
    true
  );
});
test("explicit Dave intent creates a candidate", () => {
  assert.equal(
    gatesDaveOwnership({ owner: "dave", basis: "explicit_user_intent", excerpt: "I'm going to draft the proposal." }),
    true
  );
});
test("a recommendation without an owner does not create a Dave candidate", () => {
  assert.equal(gatesDaveOwnership({ owner: "ambiguous" }), false);
});
test("someone else's task does not become Dave's", () => {
  assert.equal(
    gatesDaveOwnership({ owner: "external", actor: daveEntity, basis: "explicit_external_commitment", excerpt: "Aki will send it." }),
    false
  );
});
test("ambiguous group assignment does not create a Dave candidate", () => {
  assert.equal(gatesDaveOwnership({ owner: "ambiguous" }), false);
});
test("a valid basis with no supporting excerpt does not clear the gate", () => {
  assert.equal(gatesDaveOwnership({ owner: "dave", basis: "explicit_assignment_to_dave", excerpt: "" }), false);
  assert.equal(gatesDaveOwnership({ owner: "dave", basis: "explicit_assignment_to_dave", excerpt: "   " }), false);
});
test("an unrecognized ownership basis (malformed/untrusted model output) does not clear the gate", () => {
  assert.equal(
    gatesDaveOwnership({ owner: "dave", basis: "dave_seemed_interested", excerpt: "Dave nodded along." }),
    false
  );
});

test("an explicit external commitment with a known actor creates external state", () => {
  assert.equal(
    gatesExternalOwnership({ owner: "external", actor: daveEntity, basis: "explicit_external_commitment", excerpt: "I'll send Dave the security review Thursday. — Aki" }),
    true
  );
});
test("external ownership requires an identifiable actor", () => {
  assert.equal(
    gatesExternalOwnership({ owner: "external", actor: noEntity, basis: "explicit_external_commitment", excerpt: "Someone will handle it." }),
    false
  );
});
test("a Dave-owned item is never externally owned", () => {
  assert.equal(
    gatesExternalOwnership({ owner: "dave", basis: "explicit_user_intent", excerpt: "I'll do it." }),
    false
  );
});
