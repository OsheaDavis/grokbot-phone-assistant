import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/http/server.js";
import { EXAMPLE_CARD_HASH, EXAMPLE_CARD_ID, installCard } from "./card-fixture.js";
import { ApprovalStore } from "../src/outbound/approval.js";
import { FINISH_GRACE_SECONDS, type OutboundCallRequest, type OutboundTwilioClient } from "../src/outbound/dialer.js";
import { createTwilioRestClient, outboundClientFor } from "../src/outbound/twilio-client.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import { testConfig, tempStore } from "./fixtures.js";
import { withServer } from "./http-util.js";

const BEARER = "outbound-client-bearer-value";
const ON: NodeJS.ProcessEnv = { OUTBOUND_ENABLED: "1", OUTBOUND_BEARER_TOKEN: BEARER, OUTBOUND_ALLOWLIST: "+12025550100", OUTBOUND_CALLBACK_NUMBER: "+12025550142" };
const NUMBER = "+12025550100";
const NOW = Date.parse("2026-07-15T18:00:00.000Z");
const SID = "AC" + "0".repeat(32);
const TOKEN = "fake-token-for-tests";
const STATUS_URL = "https://example.com/outbound/status";

function fakeFetch(reply: { status: number; body: unknown }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { impl, seen };
}

const REQ: OutboundCallRequest = {
  from: "+12025550123",
  to: NUMBER,
  record: false,
  timeLimit: 600,
  twiml: "<Response><Hangup/></Response>",
  statusCallback: STATUS_URL,
};

test("REST client posts one form to the Calls resource with record false and basic auth", async () => {
  const f = fakeFetch({ status: 201, body: { sid: "CA" + "1".repeat(32) } });
  const client = createTwilioRestClient({ accountSid: SID, authToken: TOKEN, fetchImpl: f.impl });
  const out = await client.calls.create(REQ);
  assert.equal(out.sid, "CA" + "1".repeat(32));
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0]!.url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
  assert.equal(f.seen[0]!.init.method, "POST");
  assert.equal(f.seen[0]!.init.redirect, "error");
  const form = new URLSearchParams(String(f.seen[0]!.init.body));
  assert.equal(form.get("From"), "+12025550123");
  assert.equal(form.get("To"), NUMBER);
  assert.equal(form.get("Record"), "false");
  assert.equal(form.get("TimeLimit"), "600");
  assert.equal(form.get("Twiml"), REQ.twiml);
  assert.equal(form.get("StatusCallback"), STATUS_URL);
  assert.equal(form.get("StatusCallbackEvent"), "completed");
  assert.equal(form.get("Url"), null);
  const headers = f.seen[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
});

test("REST client errors do not carry the token or body", async () => {
  const f = fakeFetch({ status: 401, body: { message: "secret detail" } });
  const client = createTwilioRestClient({ accountSid: SID, authToken: TOKEN, fetchImpl: f.impl });
  await assert.rejects(client.calls.create(REQ), (err: Error) => {
    assert.equal(err.message, "twilio_status_401");
    return true;
  });
  await assert.rejects(client.calls.create({ ...REQ, record: true as unknown as false }), /record_must_be_false/);
  assert.equal(f.seen.length, 1);
  assert.throws(() => createTwilioRestClient({ accountSid: "nope", authToken: TOKEN }), /bad_account_sid/);
});

test("no client is built when outbound is disabled or credentials are missing", () => {
  const creds = { accountSid: SID, authToken: TOKEN };
  for (const env of [{}, { OUTBOUND_ENABLED: "0" }, { OUTBOUND_ENABLED: "" }, { OUTBOUND_ENABLED: "maybe" }]) {
    assert.equal(outboundClientFor(env, creds), undefined, JSON.stringify(env));
  }
  assert.equal(outboundClientFor(ON, { accountSid: undefined, authToken: TOKEN }), undefined);
  assert.equal(outboundClientFor(ON, { accountSid: SID, authToken: undefined }), undefined);
  assert.ok(outboundClientFor(ON, creds));
});

function harness(env: NodeJS.ProcessEnv = ON) {
  const calls: OutboundCallRequest[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const client: OutboundTwilioClient = {
    calls: {
      async create(request) {
        calls.push(request);
        return { sid: `CA${String(calls.length).padStart(32, "0")}` };
      },
    },
  };
  const store = new ApprovalStore();
  const config = testConfig();
  installCard(config.dataDir, NUMBER);
  const app = createApp({
    config,
    store: tempStore(),
    outboundEnv: env,
    outboundStore: store,
    outboundClient: client,
    outboundSchedule: (fn, ms) => timers.push({ fn, ms }),
    now: () => NOW,
  });
  return { app, store, calls, timers };
}

async function json(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function placeOne(base: string) {
  const card = await json(base, "/outbound/approval", { business: "Owner test", number: NUMBER, purpose: "opener test", cardId: EXAMPLE_CARD_ID, cardHash: EXAMPLE_CARD_HASH });
  assert.equal(card.status, 201);
  const id = card.json.id as string;
  const d = await json(base, "/outbound/dial", { approvalId: id, code: card.json.code, confirmNumber: NUMBER });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  return { id, sid: d.json.callSid as string };
}

async function status(base: string, params: Record<string, string>, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const sig = signature ?? computeTwilioSignature("test-auth-token", STATUS_URL, params);
  if (sig) headers["x-twilio-signature"] = sig;
  const res = await fetch(`${base}/outbound/status`, { method: "POST", headers, body: new URLSearchParams(params).toString() });
  return res.status;
}

test("signed terminal status marks the call finished and frees the line", async () => {
  const h = harness();
  await withServer(h.app, async (base) => {
    const { id, sid } = await placeOne(base);
    assert.equal(h.store.isBusy(), true);
    assert.equal(await status(base, { CallSid: sid, CallStatus: "ringing" }), 200);
    assert.equal(h.store.isBusy(), true);
    assert.equal(await status(base, { CallSid: sid, CallStatus: "completed", CallDuration: "42" }), 200);
    assert.equal(h.store.isBusy(), false);
    assert.equal(h.store.get(id)?.status, "burned");
    // A second card can now dial.
    await placeOne(base);
  });
  assert.equal(h.calls.length, 2);
});

test("bad, missing, or wrong-URL signature is rejected and the call stays busy", async () => {
  const h = harness();
  await withServer(h.app, async (base) => {
    const { sid } = await placeOne(base);
    const params = { CallSid: sid, CallStatus: "completed", CallDuration: "5" };
    assert.equal(await status(base, params, ""), 403);
    assert.equal(await status(base, params, "AAAA"), 403);
    const other = computeTwilioSignature("test-auth-token", "https://evil.example/outbound/status", params);
    assert.equal(await status(base, params, other), 403);
    const tampered = computeTwilioSignature("test-auth-token", STATUS_URL, { ...params, CallDuration: "1" });
    assert.equal(await status(base, params, tampered), 403);
    assert.equal(h.store.isBusy(), true);
  });
});

test("safety timeout frees the line at timeLimit plus grace and is harmless after finish", async () => {
  const h = harness();
  await withServer(h.app, async (base) => {
    const { id, sid } = await placeOne(base);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0]!.ms, (90 + FINISH_GRACE_SECONDS) * 1000);
    h.timers[0]!.fn();
    assert.equal(h.store.isBusy(), false);
    assert.equal(h.store.get(id)?.status, "burned");
    // A late status callback after the timeout changes nothing.
    assert.equal(await status(base, { CallSid: sid, CallStatus: "completed", CallDuration: "9" }), 200);
    const second = await placeOne(base);
    assert.equal(await status(base, { CallSid: second.sid, CallStatus: "no-answer" }), 200);
    assert.equal(h.store.isBusy(), false);
    h.timers[1]!.fn();
    assert.equal(h.store.isBusy(), false);
  });
});

test("status route is 404 when outbound is off", async () => {
  const h = harness({});
  await withServer(h.app, async (base) => {
    assert.equal(await status(base, { CallSid: "CA1", CallStatus: "completed" }), 404);
  });
});

test("dial is refused without a public base URL for the status callback", async () => {
  const calls: OutboundCallRequest[] = [];
  const app = createApp({
    config: { ...testConfig(), publicBaseUrl: undefined },
    store: tempStore(),
    outboundEnv: ON,
    outboundStore: new ApprovalStore(),
    outboundClient: { calls: { async create(r) { calls.push(r); return { sid: "CA" + "2".repeat(32) }; } } },
    now: () => NOW,
  });
  await withServer(app, async (base) => {
    const card = await json(base, "/outbound/approval", { business: "Owner test", number: NUMBER, purpose: "opener test", cardId: EXAMPLE_CARD_ID, cardHash: EXAMPLE_CARD_HASH });
    const d = await json(base, "/outbound/dial", { approvalId: card.json.id, code: card.json.code, confirmNumber: NUMBER });
    assert.equal(d.status, 503);
    assert.equal(d.json.error, "no_callback");
  });
  assert.equal(calls.length, 0);
});
