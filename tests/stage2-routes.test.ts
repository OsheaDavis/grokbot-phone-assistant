import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createApp } from "../src/http/server.js";
import { ApprovalStore } from "../src/outbound/approval.js";
import type { OutboundCallRequest, OutboundTwilioClient } from "../src/outbound/dialer.js";
import { proposeLessons, writeLessons, type LoggedOutcome } from "../src/outbound/outcome-log.js";
import { createTwilioRestClient } from "../src/outbound/twilio-client.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import type { CallSummary } from "../src/types.js";
import { EXAMPLE_CARD_HASH, EXAMPLE_CARD_ID, installCard } from "./card-fixture.js";
import { testConfig, tempStore } from "./fixtures.js";
import { withServer } from "./http-util.js";

const BEARER = "stage2-route-bearer";
const NUMBER = "+12025550100";
const ON: NodeJS.ProcessEnv = { OUTBOUND_ENABLED: "1", OUTBOUND_BEARER_TOKEN: BEARER, OUTBOUND_ALLOWLIST: NUMBER, OUTBOUND_CALLBACK_NUMBER: "+12025550142" };
const NOW = Date.parse("2026-07-15T18:00:00.000Z");
const APPROVAL = { business: "Example Partner", number: NUMBER, purpose: "Example returns check", cardId: EXAMPLE_CARD_ID, cardHash: EXAMPLE_CARD_HASH };

function build(envOverride?: NodeJS.ProcessEnv, clock = { t: NOW }) {
  const calls: OutboundCallRequest[] = [];
  const summaries: CallSummary[] = [];
  const client: OutboundTwilioClient = {
    calls: {
      async create(request) {
        calls.push(request);
        return { sid: `CA${String(calls.length).padStart(32, "0")}` };
      },
    },
  };
  const config = testConfig();
  const installed = installCard(config.dataDir, NUMBER);
  const app = createApp({
    config,
    store: tempStore(),
    outboundEnv: envOverride ?? ON,
    outboundStore: new ApprovalStore(),
    outboundClient: client,
    outboundSchedule: () => undefined,
    now: () => clock.t,
    postSummary: async (opts) => {
      summaries.push(opts.summary);
      return { status: "delivered", attempts: 1 };
    },
  });
  return { app, calls, summaries, config, installed };
}

async function post(base: string, p: string, body: unknown) {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function twilio(base: string, publicUrl: string, params: Record<string, string>, sign = true) {
  const u = new URL(publicUrl);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (sign) headers["x-twilio-signature"] = computeTwilioSignature("test-auth-token", publicUrl, params);
  const res = await fetch(`${base}${u.pathname}${u.search}`, { method: "POST", headers, body: new URLSearchParams(params).toString() });
  return { status: res.status, text: await res.text() };
}

test("approval: card missing, bad hash, tampered card, unknown card, number not matching the card's reference -> 400", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const { cardId: _c, cardHash: _h, ...noCard } = APPROVAL;
    assert.deepEqual((await post(base, "/outbound/approval", noCard)).json, { error: "card_missing" });
    assert.deepEqual((await post(base, "/outbound/approval", { ...APPROVAL, cardHash: "abc" })).json, { error: "card_hash_mismatch" });
    assert.deepEqual((await post(base, "/outbound/approval", { ...APPROVAL, cardHash: "f".repeat(64) })).json, { error: "card_hash_mismatch" });
    assert.deepEqual((await post(base, "/outbound/approval", { ...APPROVAL, cardId: "no-such-card" })).json, { error: "card_missing" });
    // Allowlisted but not the card's number.
    fs.writeFileSync(path.join(h.installed.dir, "numbers.json"), JSON.stringify({ EXAMPLE_PARTNER: "+12025550111" }));
    const r = await post(base, "/outbound/approval", APPROVAL);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "card_number_mismatch" });
  });
  assert.equal(h.calls.length, 0);
});

test("approval returns the card id, hash, opener, give/take and caps; tamper before dial -> 403, no Twilio call", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const a = await post(base, "/outbound/approval", APPROVAL);
    assert.equal(a.status, 201, JSON.stringify(a.json));
    assert.equal(a.json.cardId, EXAMPLE_CARD_ID);
    assert.equal(a.json.cardHash, EXAMPLE_CARD_HASH);
    assert.deepEqual(a.json.give, ["callback_number"]);
    assert.equal(a.json.maxTurns, 3);
    assert.equal(a.json.maxSeconds, 90);
    assert.equal(a.json.record, false);
    const file = path.join(h.installed.dir, `${EXAMPLE_CARD_ID}.json`);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("good night", "good nite"));
    const d = await post(base, "/outbound/dial", { approvalId: a.json.id, code: a.json.code, confirmNumber: NUMBER });
    assert.equal(d.status, 403);
    assert.deepEqual(d.json, { error: "card_hash_mismatch" });
  });
  assert.equal(h.calls.length, 0);
});

test("full call over HTTP: dial -> signed turns -> status -> outcome log, lessons, summary to webhook", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const a = await post(base, "/outbound/approval", APPROVAL);
    const d = await post(base, "/outbound/dial", { approvalId: a.json.id, code: a.json.code, confirmNumber: NUMBER });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const sid = d.json.callSid as string;
    const startUrl = h.calls[0]!.url!;
    // Unsigned turn is refused.
    assert.equal((await twilio(base, startUrl, { CallSid: sid }, false)).status, 403);
    const first = await twilio(base, startUrl, { CallSid: sid, AnsweredBy: "human" });
    assert.equal(first.status, 200);
    assert.match(first.text, /<Gather input="speech"/);
    const action = /action="([^"]+)"/.exec(first.text)![1]!.replace(/&amp;/g, "&");
    const second = await twilio(base, action, { CallSid: sid, SpeechResult: "No, nothing tonight" });
    assert.match(second.text, /<Say>Thank you, have a good night\.<\/Say>\n  <Hangup\/>/);
    const statusUrl = "https://example.com/outbound/status";
    assert.equal((await twilio(base, statusUrl, { CallSid: sid, CallStatus: "completed", CallDuration: "21" })).status, 200);
  });
  const log = fs.readFileSync(path.join(h.config.dataDir, "call-logs", "outbound", "business.jsonl"), "utf8").trim().split("\n");
  assert.equal(log.length, 1);
  const row = JSON.parse(log[0]!) as LoggedOutcome;
  assert.equal(row.outcome, "no");
  assert.equal(row.durationSec, 21);
  assert.equal(row.cardHash, EXAMPLE_CARD_HASH);
  assert.doesNotMatch(log[0]!, /nothing tonight/);
  assert.ok(fs.existsSync(path.join(h.config.dataDir, "call-lessons", "business.md")));
  assert.equal(h.summaries.length, 1);
  assert.equal(h.summaries[0]!.reason, "Outbound returns check: no");
  assert.equal(h.summaries[0]!.caller_number, null);
  assert.match(h.summaries[0]!.transcript_summary, /Result: no\./);
  assert.doesNotMatch(JSON.stringify(h.summaries[0]), /555/);
});

test("every call is reported: a no-answer with no turns still logs and posts a summary", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const a = await post(base, "/outbound/approval", APPROVAL);
    const d = await post(base, "/outbound/dial", { approvalId: a.json.id, code: a.json.code, confirmNumber: NUMBER });
    await twilio(base, "https://example.com/outbound/status", { CallSid: d.json.callSid as string, CallStatus: "no-answer" });
  });
  assert.equal(h.summaries.length, 1);
  assert.equal(h.summaries[0]!.reason, "Outbound returns check: no_answer");
});

test("turn route is 404 when outbound is off and 405 for GET", async () => {
  const config = testConfig();
  const app = createApp({ config, store: tempStore(), outboundEnv: {} });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/outbound/turn?s=x`, { method: "POST" })).status, 404);
  });
  const h = build();
  await withServer(h.app, async (base) => {
    assert.equal((await fetch(`${base}/outbound/turn?s=x`)).status, 405);
  });
});

test("lessons are proposals only and never touch call-cards", () => {
  const h = build();
  const before = fs.readFileSync(path.join(h.installed.dir, `${EXAMPLE_CARD_ID}.json`), "utf8");
  const dir = path.join(h.config.dataDir, "call-logs", "outbound");
  fs.mkdirSync(dir, { recursive: true });
  const row = (outcome: string) => JSON.stringify({ outcome, type: "business", item: null }) + "\n";
  fs.writeFileSync(path.join(dir, "business.jsonl"), row("unclear") + row("unclear") + row("refused") + row("yes"));
  const { file, lessons } = writeLessons(h.config.dataDir, "business", "2026-07-15T18:00:00.000Z");
  assert.ok(lessons.length >= 2);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /proposals only/i);
  assert.match(text, /2\/4 calls ended unclear/);
  assert.equal(fs.readFileSync(path.join(h.installed.dir, `${EXAMPLE_CARD_ID}.json`), "utf8"), before);
  assert.ok(file.startsWith(path.join(h.config.dataDir, "call-lessons")));
  assert.deepEqual(proposeLessons([]), []);
  // A hostile type cannot escape the lessons folder.
  const escaped = writeLessons(h.config.dataDir, "../call-cards/example-returns-v1", "x").file;
  assert.equal(path.basename(escaped), "unknown.md");
});

test("REST client: stage 2 sends Url + Method + MachineDetection, never Twiml or Record=true; requires https", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ sid: "CA1" }), { status: 201 });
  }) as unknown as typeof fetch;
  const c = createTwilioRestClient({ accountSid: `AC${"0".repeat(32)}`, authToken: "t", fetchImpl });
  const base = { from: "+12025550123" as const, to: NUMBER, record: false as const, timeLimit: 90 };
  await c.calls.create({ ...base, url: "https://example.com/outbound/turn?s=a.b", machineDetection: "Enable" });
  const form = new URLSearchParams(bodies[0]);
  assert.equal(form.get("Url"), "https://example.com/outbound/turn?s=a.b");
  assert.equal(form.get("Method"), "POST");
  assert.equal(form.get("MachineDetection"), "Enable");
  assert.equal(form.get("Record"), "false");
  assert.equal(form.get("Twiml"), null);
  await assert.rejects(c.calls.create({ ...base, url: "http://example.com/x" }), /url_must_be_https/);
  await assert.rejects(c.calls.create({ ...base }), /one_of_twiml_or_url/);
  await assert.rejects(c.calls.create({ ...base, url: "https://e.com", twiml: "<Response/>" }), /one_of_twiml_or_url/);
});

async function placeCall(h: ReturnType<typeof build>, base: string) {
  const a = await post(base, "/outbound/approval", APPROVAL);
  assert.equal(a.status, 201, JSON.stringify(a.json));
  const d = await post(base, "/outbound/dial", { approvalId: a.json.id, code: a.json.code, confirmNumber: NUMBER });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  return { sid: d.json.callSid as string, startUrl: h.calls.at(-1)!.url! };
}

test("turn route: bad signature and missing signature are 403; nothing spoken", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const { sid, startUrl } = await placeCall(h, base);
    const u = new URL(startUrl);
    const body = new URLSearchParams({ CallSid: sid, AnsweredBy: "human" }).toString();
    for (const sig of [undefined, "", "bm90LWEtc2lnbmF0dXJl", computeTwilioSignature("wrong-token", startUrl, { CallSid: sid, AnsweredBy: "human" })]) {
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      if (sig !== undefined) headers["x-twilio-signature"] = sig;
      const res = await fetch(`${base}${u.pathname}${u.search}`, { method: "POST", headers, body });
      assert.equal(res.status, 403, String(sig));
      assert.doesNotMatch(await res.text(), /<Say>/);
    }
    // Signature valid for a different URL (tampered s=) is also 403.
    const tampered = startUrl.replace(/s=./, "s=X");
    const sig = computeTwilioSignature("test-auth-token", startUrl, { CallSid: sid });
    const res = await fetch(`${base}${new URL(tampered).pathname}${new URL(tampered).search}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig },
      body: new URLSearchParams({ CallSid: sid }).toString(),
    });
    assert.equal(res.status, 403);
  });
});

test("turn route: an expired signed link hangs up without speaking", async () => {
  const clock = { t: NOW };
  const h = build(undefined, clock);
  await withServer(h.app, async (base) => {
    const { sid, startUrl } = await placeCall(h, base);
    clock.t = NOW + 3 * 60 * 1000 + 1;
    const r = await twilio(base, startUrl, { CallSid: sid, AnsweredBy: "human" });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /<Say>|<Gather/);
    assert.match(r.text, /<Hangup\/>/);
  });
});

const CALLBACK_CASES = [
  ["callback_missing", {}],
  ["callback_malformed", { OUTBOUND_CALLBACK_NUMBER: "(202) 555-0142" }],
  ["callback_malformed", { OUTBOUND_CALLBACK_NUMBER: "+44207946000" }],
  ["callback_is_bot_line", { OUTBOUND_CALLBACK_NUMBER: "+12025550123" }],
  ["callback_in_allowlist", { OUTBOUND_CALLBACK_NUMBER: NUMBER }],
] as const;

for (const [reason, extra] of CALLBACK_CASES) {
  test(`callback ${reason} (${JSON.stringify(extra).length}): approval 400 and dial 403, value never echoed`, async () => {
    const { OUTBOUND_CALLBACK_NUMBER: _drop, ...rest } = ON;
    const bad: NodeJS.ProcessEnv = { ...rest, ...extra };
    const h1 = build(bad);
    await withServer(h1.app, async (base) => {
      const a = await post(base, "/outbound/approval", APPROVAL);
      assert.equal(a.status, 400);
      assert.deepEqual(a.json, { error: reason });
    });
    // Approved while valid, then the env goes bad before the dial.
    const env: NodeJS.ProcessEnv = { ...ON };
    const h2 = build(env);
    await withServer(h2.app, async (base) => {
      const a = await post(base, "/outbound/approval", APPROVAL);
      assert.equal(a.status, 201);
      delete env.OUTBOUND_CALLBACK_NUMBER;
      Object.assign(env, extra);
      const d = await post(base, "/outbound/dial", { approvalId: a.json.id, code: a.json.code, confirmNumber: NUMBER });
      assert.equal(d.status, 403);
      assert.deepEqual(d.json, { error: reason });
    });
    assert.equal(h2.calls.length, 0);
  });
}

test("summary carries item, pickup, transcript-free result and lessons as proposals", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    const { sid, startUrl } = await placeCall(h, base);
    const first = await twilio(base, startUrl, { CallSid: sid, AnsweredBy: "human" });
    const a1 = /action="([^"]+)"/.exec(first.text)![1]!.replace(/&amp;/g, "&");
    const second = await twilio(base, a1, { CallSid: sid, SpeechResult: "Yes we do, my name is Dana" });
    const a2 = /action="([^"]+)"/.exec(second.text)![1]!.replace(/&amp;/g, "&");
    await twilio(base, a2, { CallSid: sid, SpeechResult: "Two sets of keys, come by tomorrow morning, ask for Dana" });
    await twilio(base, "https://example.com/outbound/status", { CallSid: sid, CallStatus: "completed", CallDuration: "40" });
  });
  const text = h.summaries[0]!.transcript_summary;
  assert.match(text, /Result: yes\./);
  assert.match(text, /Item: keys\./);
  assert.match(text, /Pickup: tomorrow, morning\./);
  assert.match(text, /Lessons \(proposals only, nothing changed\): /);
  assert.doesNotMatch(JSON.stringify(h.summaries[0]), /Dana|come by|sets of/);
});

test("summary: lessons proposals appear once there is history; unknown item/pickup are explicit", async () => {
  const h = build();
  await withServer(h.app, async (base) => {
    for (let i = 0; i < 2; i += 1) {
      const { sid, startUrl } = await placeCall(h, base);
      const first = await twilio(base, startUrl, { CallSid: sid, AnsweredBy: "human" });
      let xml = first.text;
      for (const said of ["hmm", "uh"]) {
        const m = /action="([^"]+)"/.exec(xml);
        if (!m) break;
        xml = (await twilio(base, m[1]!.replace(/&amp;/g, "&"), { CallSid: sid, SpeechResult: said })).text;
      }
      await twilio(base, "https://example.com/outbound/status", { CallSid: sid, CallStatus: "completed", CallDuration: "30" });
    }
  });
  const last = h.summaries.at(-1)!.transcript_summary;
  assert.match(last, /Result: unclear\./);
  assert.match(last, /Item: unknown\. Pickup: unknown\./);
  assert.match(last, /2\/2 calls ended unclear/);
});
