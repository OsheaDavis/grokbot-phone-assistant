import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { createState, finalizeCall, onXaiEvent } from "../src/bridge/machine.js";
import { URGENT_NOTICE } from "../src/prompt.js";
import { createApp } from "../src/http/server.js";
import { looksLikeSales } from "../src/money.js";
import { deliverSummary } from "../src/summary/deliver.js";
import { summaryFromLog } from "../src/summary/payload.js";
import { signSummary } from "../src/summary/sign.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import { clearStreamGrantsForTests } from "../src/twilio/stream-token.js";
import type { CallSummary } from "../src/types.js";
import { sampleEntry, testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

function machine() {
  return createState({
    callSid: "CA123",
    callerNumber: "+15551212000",
    startedAtMs: Date.parse("2026-10-11T15:00:00.000Z"),
    voice: "your-voice-id",
    pronunciation: false,
    instructions: "Take a message.",
    flags: [],
  });
}

function record(call: ReturnType<typeof machine>, args: Record<string, unknown>, id = "call_urgent") {
  return onXaiEvent(call, {
    type: "response.function_call_arguments.done",
    name: "record_message",
    call_id: id,
    arguments: JSON.stringify(args),
  });
}

function outputOf(step: ReturnType<typeof record>): Record<string, unknown> {
  const payload = step.outbound[0]?.payload as { item: { output: string } };
  return JSON.parse(payload.item.output) as Record<string, unknown>;
}

test("urgent is set for a family emergency and cleared when the call is a scam or a sale", () => {
  assert.equal(looksLikeSales("This is a sales call"), true);
  assert.equal(looksLikeSales("Mom is in the hospital"), false);

  const emergency = machine();
  const saved = record(emergency, {
    name: "Mom",
    reason: "Mom is in the hospital and needs you.",
    urgent: true,
    urgent_reason: "hospital",
  });
  assert.equal(outputOf(saved).urgent, true);
  assert.equal(outputOf(saved).say, URGENT_NOTICE);
  assert.equal(emergency.flags.includes("urgent"), true);
  assert.equal(emergency.flags.includes("possible_scam"), false);
  const emergencyEntry = finalizeCall(emergency, Date.parse("2026-10-11T15:05:00.000Z"));
  const emergencySummary = summaryFromLog(emergencyEntry);
  assert.equal(emergencySummary.urgent, true);
  assert.equal(emergencySummary.flags.includes("urgent"), true);
  assert.equal(JSON.stringify(emergencySummary).includes("hospital"), true);

  const scam = machine();
  const blocked = record(scam, {
    name: "Mom",
    reason: "Mom is in the hospital. Wire the payment right now.",
    urgent: true,
    urgent_reason: "hospital",
  });
  assert.equal(outputOf(blocked).urgent, false);
  assert.equal("say" in outputOf(blocked), false);
  assert.equal(scam.flags.includes("possible_scam"), true);
  assert.equal(scam.flags.includes("urgent"), false);
  assert.equal(summaryFromLog(finalizeCall(scam, Date.parse("2026-10-11T15:05:00.000Z"))).urgent, false);

  const later = machine();
  record(later, { name: "Mom", reason: "She is in the hospital.", urgent: true, urgent_reason: "hospital" }, "call_a");
  assert.equal(later.flags.includes("urgent"), true);
  onXaiEvent(later, {
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Please wire the payment with a gift card.",
  });
  assert.equal(later.flags.includes("possible_scam"), true);
  assert.equal(later.flags.includes("urgent"), false);
  assert.equal(summaryFromLog(finalizeCall(later, Date.parse("2026-10-11T15:06:00.000Z"))).urgent, false);

  const sale = machine();
  record(sale, { name: "Pat", reason: "This is a sales call about a new plan.", urgent: true, urgent_reason: "offer" });
  assert.equal(sale.flags.includes("urgent"), false);
  assert.equal(sale.flags.includes("possible_scam"), false);
  assert.equal(summaryFromLog(finalizeCall(sale, Date.parse("2026-10-11T15:05:00.000Z"))).urgent, false);
});

test("GET /messages?urgent=1 returns only calls that stayed urgent", async () => {
  const store = tempStore();
  await store.append(sampleEntry({ id: "urgent-1", flags: ["urgent"], end_time: "2026-10-10T00:05:00.000Z" }));
  await store.append(
    sampleEntry({
      id: "scam-1",
      flags: ["possible_scam", "urgent"],
      message: { name: "Scam", callback_number: "+15551212000", reason: "wire it" },
      end_time: "2026-10-10T00:06:00.000Z",
    }),
  );
  await store.append(sampleEntry({ id: "plain-1", flags: [], end_time: "2026-10-10T00:07:00.000Z" }));
  const app = createApp({ config: testConfig(), store });
  await withServer(app, async (base) => {
    const headers = { authorization: "Bearer test-messages-bearer" };
    const denied = await fetch(`${base}/messages?urgent=1`);
    assert.equal(denied.status, 401);
    const bad = await fetch(`${base}/messages?urgent=yes`, { headers });
    assert.equal(bad.status, 400);
    const only = await fetch(`${base}/messages?urgent=1`, { headers });
    assert.equal(only.status, 200);
    const body = (await only.json()) as { messages: CallSummary[] };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]?.urgent, true);
    assert.equal(body.messages[0]?.name, "Jane");
    const all = await fetch(`${base}/messages`, { headers });
    const everyone = (await all.json()) as { messages: CallSummary[] };
    assert.equal(everyone.messages.length, 3);
    assert.equal(everyone.messages.filter((message) => message.urgent).length, 1);
    assert.equal(everyone.messages.some((message) => message.flags.includes("possible_scam") && message.urgent), false);
  });
});

test("call end posts a redacted summary with urgent and X-Signature", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callers-"));
  const callers = path.join(dir, "callers.json");
  fs.writeFileSync(callers, JSON.stringify({ allowlist: [], blocklist: ["+15554440000"] }));
  const posted: CallSummary[] = [];
  const store = tempStore();
  const app = createApp({
    config: testConfig({
      callersConfigPath: callers,
      summaryWebhookUrl: "https://desk.example/summary",
      summaryWebhookSecret: "test-secret-value",
    }),
    store,
    postSummary: async (opts) => {
      posted.push(opts.summary);
      assert.equal(opts.secret, "test-secret-value");
      return { status: "delivered", attempts: 1 };
    },
  });
  await withServer(app, async (base) => {
    const params = { CallSid: "CABlock1", From: "+15554440000", To: "+12025550123" };
    const signature = computeTwilioSignature("test-auth-token", "https://example.com/voice", params);
    const result = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(result.status, 200);
    await app.drain();
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.urgent, false);
  assert.equal(posted[0]?.flags.includes("blocked"), true);
  assert.equal(JSON.stringify(posted[0]).includes("test-secret-value"), false);

  const secret = "test-secret-value";
  let signature = "";
  let raw = "";
  const delivered = await deliverSummary({
    url: "https://desk.example/hook",
    secret,
    summary: summaryFromLog(
      sampleEntry({
        flags: ["urgent"],
        message: { name: "Mom", callback_number: "+15551212000", reason: "card 4111-1111-1111-1111" },
        transcript_summary: "Caller: account 4111111111111111",
      }),
    ),
    timeoutMs: 200,
    maxAttempts: 3,
    retryBaseMs: 0,
    nowMs: () => 1_700_000_000_000,
    resolveHost: async () => ["203.0.113.10"],
    fetchImpl: async (_url, init) => {
      raw = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      signature = headers["X-Signature"] ?? "";
      assert.equal(headers["X-Summary-Signature"], signature);
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(raw.includes("4111"), false);
  assert.equal(raw.includes('"urgent":true'), true);
  assert.equal(signature, `sha256=${signSummary(secret, "1700000000", raw)}`);
  assert.equal(raw.includes(secret), false);
});

test("every call is delivered, including an auto summary and an urgent call", async () => {
  clearStreamGrantsForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callers-"));
  const callers = path.join(dir, "callers.json");
  fs.writeFileSync(callers, JSON.stringify({ allowlist: [], blocklist: ["+15554440000"] }));
  const posted: CallSummary[] = [];
  let mode: "auto" | "urgent" = "auto";
  const app = createApp({
    config: testConfig({
      callersConfigPath: callers,
      summaryWebhookUrl: "https://desk.example/summary",
      summaryWebhookAuth: "desk-auth-token",
    }),
    store: tempStore(),
    bridge: (input) => {
      try {
        const state = createState({
          callSid: input.callSid,
          callerNumber: input.callerNumber,
          startedAtMs: input.startedAtMs,
          voice: "leo",
          pronunciation: false,
          instructions: "Take a message.",
          flags: input.flags,
        });
        if (mode === "auto") {
          onXaiEvent(state, {
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "item_auto",
            transcript: "This is Pat. Please call me back about the porch.",
          });
        } else {
          onXaiEvent(state, {
            type: "response.function_call_arguments.done",
            name: "record_message",
            call_id: "call_urgent",
            arguments: JSON.stringify({
              name: "Mom",
              reason: "Mom is in the hospital and needs you.",
              urgent: true,
              urgent_reason: "hospital",
            }),
          });
        }
        input.onComplete(finalizeCall(state, input.startedAtMs + 1000));
      } finally {
        input.twilio.close();
      }
    },
    postSummary: async (opts) => {
      assert.equal(opts.auth, "desk-auth-token");
      assert.equal(opts.secret, undefined);
      assert.equal(typeof opts.summary.urgent, "boolean");
      posted.push(opts.summary);
      return { status: "delivered", attempts: 1 };
    },
  });

  const voice = async (base: string, sid: string, from: string): Promise<string> => {
    const params = { CallSid: sid, From: from, To: "+12025550123" };
    const signature = computeTwilioSignature("test-auth-token", "https://example.com/voice", params);
    const result = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(result.status, 200);
    return result.text;
  };

  await withServer(app, async (base) => {
    await voice(base, "CABLOCKAUTH", "+15554440000");
    await app.drain();

    const autoTwiml = await voice(base, "CAAUTO1", "+15551212000");
    const autoMatch = /<Stream url="([^"]+)"/.exec(autoTwiml);
    if (!autoMatch?.[1]) throw new Error("missing stream url");
    const autoUrl = new URL(autoMatch[1].replaceAll("&amp;", "&"));
    const autoSocket = new WebSocket(`ws://${new URL(base).host}${autoUrl.pathname}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        autoSocket.terminate();
        reject(new Error("auto summary socket timeout"));
      }, 1000);
      autoSocket.on("error", () => undefined);
      autoSocket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await app.drain();

    mode = "urgent";
    const urgentTwiml = await voice(base, "CAURGENT1", "+15551212000");
    const urgentMatch = /<Stream url="([^"]+)"/.exec(urgentTwiml);
    if (!urgentMatch?.[1]) throw new Error("missing stream url");
    const urgentUrl = new URL(urgentMatch[1].replaceAll("&amp;", "&"));
    const urgentSocket = new WebSocket(`ws://${new URL(base).host}${urgentUrl.pathname}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        urgentSocket.terminate();
        reject(new Error("urgent socket timeout"));
      }, 1000);
      urgentSocket.on("error", () => undefined);
      urgentSocket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await app.drain();
  });

  assert.equal(posted.length, 3);
  assert.equal(posted[0]?.flags.includes("blocked"), true);
  assert.equal(posted[0]?.name, null);
  assert.equal(posted[0]?.urgent, false);
  assert.equal(posted[1]?.flags.includes("auto_summary"), true);
  assert.equal(posted[1]?.name, null);
  assert.equal(posted[1]?.reason, "This is Pat. Please call me back about the porch.");
  assert.equal(posted[1]?.urgent, false);
  assert.equal(posted[2]?.flags.includes("urgent"), true);
  assert.equal(posted[2]?.flags.includes("auto_summary"), false);
  assert.equal(posted[2]?.urgent, true);
  assert.equal(posted[2]?.name, "Mom");
  assert.equal(JSON.stringify(posted).includes("desk-auth-token"), false);
});
