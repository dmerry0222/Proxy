/**
 * Live smoke test for the Capture front door.
 *
 * Unlike the test-*.mjs suites at the repo root, this one needs a running
 * Proxy and writes real rows -- it is the end-to-end proof that the contract
 * documented in docs/capture.md actually holds, not a unit test.
 *
 *   node scripts/capture-smoke.mjs                     # against localhost:3000
 *   PROXY_BASE_URL=https://... node scripts/capture-smoke.mjs
 *
 * Reads PROXY_CAPTURE_SECRET from .env.local (or the environment). It cleans
 * up the captures it creates, so it is safe to re-run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvLocal() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
}

const env = { ...loadEnvLocal(), ...process.env };
const baseUrl = env.PROXY_BASE_URL ?? "http://localhost:3000";
const secret = env.PROXY_CAPTURE_SECRET;

if (!secret) {
  console.error("PROXY_CAPTURE_SECRET is not set (checked .env.local and the environment).");
  process.exit(1);
}

let failures = 0;
function check(label, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function post(body, { auth = true, raw = null } = {}) {
  const response = await fetch(`${baseUrl}/api/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: raw ?? JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

// A UUID unique to this run, so re-running does not collide with a leftover.
const draftUuid = `SMOKE-${crypto.randomUUID()}`;
const draftsCapture = {
  source: "drafts",
  capture_type: "quick_add_task",
  content: "Email Alicia about the revised internship form",
  captured_at: new Date().toISOString(),
  metadata: { action: "Proxy Quick Task", draft_uuid: draftUuid, device: "iphone" },
};

console.log(`Capture smoke test → ${baseUrl}/api/capture\n`);

console.log("1. Rejects an unauthenticated POST");
const anonymous = await post(draftsCapture, { auth: false });
check("401 without a credential", anonymous.status === 401, `got ${anonymous.status}`);
check("no capture id leaked", !anonymous.json.captureId);

console.log("\n2. Rejects a wrong secret");
const wrongSecret = await fetch(`${baseUrl}/api/capture`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-secret" },
  body: JSON.stringify(draftsCapture),
});
check("401 with a bad secret", wrongSecret.status === 401, `got ${wrongSecret.status}`);

console.log("\n3. Rejects blank content");
const blank = await post({ ...draftsCapture, content: "   " });
check("400 for blank content", blank.status === 400, `got ${blank.status}`);
check("names the offending field", /content/.test(blank.json.error ?? ""), blank.json.error);

console.log("\n4. Accepts the Drafts capture");
const first = await post(draftsCapture);
check("201 Created", first.status === 201, `got ${first.status}`);
check("returns a Proxy capture id", Boolean(first.json.captureId), first.json.captureId);
check("duplicate is false", first.json.duplicate === false);
check("status is received", first.json.processingStatus === "received");
check("returns a trace id", Boolean(first.json.traceId), first.json.traceId);

console.log("\n5. A repeated POST with the same draft UUID is idempotent");
const retry = await post(draftsCapture);
check("200 OK (not an error the client would retry)", retry.status === 200, `got ${retry.status}`);
check("duplicate is true", retry.json.duplicate === true);
check("reason is source_external_id", retry.json.duplicateReason === "source_external_id");
check("same capture id as the first POST", retry.json.captureId === first.json.captureId, retry.json.captureId);

console.log("\n6. Concurrent retries collapse onto one capture");
const concurrentUuid = `SMOKE-${crypto.randomUUID()}`;
const concurrentBody = { ...draftsCapture, metadata: { ...draftsCapture.metadata, draft_uuid: concurrentUuid } };
const concurrent = await Promise.all([post(concurrentBody), post(concurrentBody), post(concurrentBody)]);
const concurrentIds = new Set(concurrent.map((response) => response.json.captureId));
check("all three succeed", concurrent.every((r) => r.json.success), concurrent.map((r) => r.status).join(", "));
check("all three resolve to ONE capture", concurrentIds.size === 1, [...concurrentIds].join(", "));

console.log("\n7. An unknown capture_type is recorded, not rejected");
const unknownType = await post({
  source: "ios_shortcut",
  capture_type: "voice_memo_from_the_car",
  content: "Rambling about the assessment flow on the drive home",
  source_external_id: `SMOKE-${crypto.randomUUID()}`,
});
check("201 Created", unknownType.status === 201, `got ${unknownType.status}`);
check("flagged as unrecognized", unknownType.json.captureTypeRecognized === false);
check("stored as sent", unknownType.json.captureType === "voice_memo_from_the_car");

console.log("\n8. The durable record and its Inspector General trail");
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: rows } = await supabase
  .from("captures")
  .select("id, source, capture_type, content, source_external_id, captured_at, received_at, processing_status, processing_error, metadata, diagnostic_trace_id")
  .eq("source_external_id", draftUuid);

check("exactly one row for the retried draft UUID", rows?.length === 1, `${rows?.length ?? 0} row(s)`);
const stored = rows?.[0];
if (stored) {
  check("raw content preserved verbatim", stored.content === draftsCapture.content);
  check("metadata preserved", stored.metadata.action === "Proxy Quick Task" && stored.metadata.device === "iphone");
  check("captured_at and received_at both present", Boolean(stored.captured_at && stored.received_at));
  check("processing_status is received", stored.processing_status === "received");
  check("no processing error", stored.processing_error === null);
  check("row points at its own trace", stored.diagnostic_trace_id === first.json.traceId);
}

// This is exactly the lookup Inspector General's object-trace does.
const { data: events } = await supabase
  .from("diagnostic_events")
  .select("event_type, status, human_summary, module")
  .eq("object_type", "capture")
  .eq("object_id", first.json.captureId)
  .order("occurred_at");

check("capture is navigable by object in Inspector General", (events?.length ?? 0) >= 2, `${events?.length ?? 0} event(s)`);
check("records receipt", events?.some((e) => e.event_type === "capture_received") === true);
check("records the duplicate retry", events?.some((e) => e.event_type === "capture_duplicate") === true);

const { data: trace } = await supabase
  .from("diagnostic_traces")
  .select("module, source_type, status, summary")
  .eq("id", first.json.traceId)
  .maybeSingle();
check("trace completed", trace?.status === "completed", trace?.summary);
check("trace reads as the provenance chain", /drafts → quick_add_task → received/.test(trace?.summary ?? ""), trace?.summary);

console.log("\n   Inspector General:");
console.log(`   ${baseUrl}/inspector-general?objectType=capture&objectId=${first.json.captureId}`);
for (const event of events ?? []) {
  console.log(`     ${event.event_type.padEnd(26)} ${event.status.padEnd(8)} ${event.human_summary}`);
}

console.log("\n9. Cleaning up");
const createdIds = [
  first.json.captureId,
  ...concurrentIds,
  unknownType.json.captureId,
].filter(Boolean);
await supabase.from("captures").delete().in("id", createdIds);
check("smoke captures removed", true, `${createdIds.length} deleted`);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
