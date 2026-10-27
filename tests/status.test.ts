import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/http/server.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import type { CallSummary } from "../src/types.js";
import { sampleEntry, testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

function setup(seed?: string) {
  const posted: CallSummary[] = [];
  const store = tempStore();
  const app = createApp({
    config: testConfig({ summaryWebhookUrl: "https://desk.example/summary" }),
    store,
    postSummary: async (opts) => {
      posted.push(opts.summary);
      return { status: "delivered", attempts: 1 };
    },
  });
  return { app, store, posted, seed };
}

function signed(params: Record<string, string>): Record<string, string> {
  return { "x-twilio-signature": computeTwilioSignature("test-auth-token", "https://example.com/status", params) };
}

const done = { CallSid: "CA123", From: "+15551234567", To: "+12025550123", CallStatus: "completed", CallDuration: "42" };

test("status callback with a bad signature is rejected and posts nothing", async () => {
  const { app, posted } = setup();
  await withServer(app, async (base) => {
    const result = await postForm(`${base}/status`, done, { "x-twilio-signature": "bad" });
    assert.equal(result.status, 403);
    await app.drain();
  });
  assert.equal(posted.length, 0);
});

test("status callback without a saved log posts a minimal summary once", async () => {
  const { app, posted } = setup();
  await withServer(app, async (base) => {
    assert.equal((await postForm(`${base}/status`, done, signed(done))).status, 204);
    assert.equal((await postForm(`${base}/status`, done, signed(done))).status, 204);
    await app.drain();
  });
  assert.equal(posted.length, 1);
  const s = posted[0]!;
  assert.match(s.transcript_summary, /completed, 42s/);
  assert.equal(Date.parse(s.end_time) - Date.parse(s.start_time), 42_000);
  assert.ok(s.caller_number);
});

test("status callback skips a call that already has a saved log", async () => {
  const { app, store, posted } = setup();
  await store.append(sampleEntry({ call_sid: "CA123" }));
  await withServer(app, async (base) => {
    assert.equal((await postForm(`${base}/status`, done, signed(done))).status, 204);
    await app.drain();
  });
  assert.equal(posted.length, 0);
});

test("non-terminal status posts nothing; no-answer is reported", async () => {
  const { app, posted } = setup();
  const ringing = { ...done, CallSid: "CA200", CallStatus: "ringing" };
  const missed = { ...done, CallSid: "CA201", CallStatus: "no-answer", CallDuration: "0" };
  await withServer(app, async (base) => {
    assert.equal((await postForm(`${base}/status`, ringing, signed(ringing))).status, 204);
    assert.equal((await postForm(`${base}/status`, missed, signed(missed))).status, 204);
    await app.drain();
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.transcript_summary, /no-answer/);
});
