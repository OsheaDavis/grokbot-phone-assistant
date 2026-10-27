import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { createApp } from "../src/http/server.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import { clearStreamGrantsForTests, parseMediaStreamPath, verifyStreamToken } from "../src/twilio/stream-token.js";
import { testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

const TOKEN = "test-auth-token";

function streamUrlFromTwiml(twiml: string): string {
  const match = /<Stream url="([^"]+)"/.exec(twiml);
  if (!match?.[1]) throw new Error("missing stream url");
  return match[1].replaceAll("&amp;", "&");
}

function streamSocketUrl(httpBase: string, twiml: string): string {
  const raw = streamUrlFromTwiml(twiml);
  assert.equal(raw.includes("?"), false);
  const parsed = new URL(raw);
  const base = new URL(httpBase);
  return `ws://${base.host}${parsed.pathname}`;
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timeout"));
    }, 1000);
    socket.on("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("error", () => undefined);
    socket.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`closed ${code}`));
    });
  });
}

/** Handshake refusal closes 1006. A second use of a grant closes 1008. */
function closeCode(url: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      resolve(-1);
    }, 1000);
    socket.on("error", () => undefined);
    socket.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("a media stream token is single use and a webhook replay does not mint another", async () => {
  clearStreamGrantsForTests();
  let bridges = 0;
  const app = createApp({
    config: testConfig(),
    store: tempStore(),
    bridge: () => {
      bridges += 1;
    },
  });
  await withServer(app, async (base) => {
    const params = { CallSid: "CASTREAM1", From: "+15551212000", To: "+12025550123" };
    const signature = computeTwilioSignature(TOKEN, "https://example.com/voice", params);
    const headers = { "x-twilio-signature": signature };
    const first = await postForm(`${base}/voice`, params, headers);
    const second = await postForm(`${base}/voice`, params, headers);
    assert.equal(first.status, 200);
    assert.equal(first.text, second.text);
    assert.doesNotMatch(first.text, /test-auth-token/);
    assert.doesNotMatch(first.text, /test-xai-key/);

    const url = streamSocketUrl(base, first.text);
    const socket = await openSocket(url);
    assert.equal(bridges, 1);
    assert.equal(await closeCode(url), 1008);
    assert.equal(bridges, 1);
    assert.equal(await closeCode(`${base.replace("http", "ws")}/media-stream`), 1006);
    socket.terminate();
  });
});

test("stream url has no query string and the path grant round-trips once", async () => {
  clearStreamGrantsForTests();
  let bridges = 0;
  const app = createApp({
    config: testConfig(),
    store: tempStore(),
    bridge: () => {
      bridges += 1;
    },
  });
  await withServer(app, async (base) => {
    const params = { CallSid: "CAPATH1", From: "+15551212000", To: "+12025550123" };
    const signature = computeTwilioSignature(TOKEN, "https://example.com/voice", params);
    const response = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(response.status, 200);
    const streamUrl = streamUrlFromTwiml(response.text);
    assert.equal(streamUrl.includes("?"), false);
    assert.equal(streamUrl.includes("+"), false);
    const parsed = new URL(streamUrl);
    const pathname = parsed.pathname;
    const segments = pathname.split("/");
    assert.deepEqual(segments.slice(0, 2), ["", "media-stream"]);
    assert.equal(segments.length, 7);

    const grant = parseMediaStreamPath(pathname);
    assert.ok(grant);
    const verified = verifyStreamToken({
      secret: TOKEN,
      expRaw: grant.expRaw,
      callSid: grant.callSid,
      from: grant.from,
      startedAtRaw: grant.startedAtRaw,
      token: grant.token,
      nowSec: Math.floor(Date.now() / 1000),
      production: false,
      allowInsecureDev: false,
    });
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.callSid, "CAPATH1");
      assert.equal(verified.from, "+15551212000");
    }

    const host = new URL(base).host;
    const wsUrl = `ws://${host}${pathname}`;
    const tokenSeg = segments[6] ?? "";
    const flippedToken = tokenSeg.endsWith("a") ? `${tokenSeg.slice(0, -1)}b` : `${tokenSeg.slice(0, -1)}a`;
    const tampered = [
      ["CATAMPER", segments[3], segments[4], segments[5], tokenSeg],
      [segments[2], String(Number(segments[3]) + 1), segments[4], segments[5], tokenSeg],
      [segments[2], segments[3], String(Number(segments[4]) + 1), segments[5], tokenSeg],
      [segments[2], segments[3], segments[4], Buffer.from("+15550001111", "utf8").toString("base64url"), tokenSeg],
      [segments[2], segments[3], segments[4], segments[5], flippedToken],
    ];
    for (const next of tampered) {
      const path = `/${["media-stream", ...next].join("/")}`;
      assert.notEqual(path, pathname);
      const forged = parseMediaStreamPath(path);
      const ok = forged
        ? verifyStreamToken({
            secret: TOKEN,
            expRaw: forged.expRaw,
            callSid: forged.callSid,
            from: forged.from,
            startedAtRaw: forged.startedAtRaw,
            token: forged.token,
            nowSec: Math.floor(Date.now() / 1000),
            production: false,
            allowInsecureDev: false,
          }).ok
        : false;
      assert.equal(ok, false);
      assert.equal(await closeCode(`ws://${host}${path}`), 1006);
    }
    assert.equal(parseMediaStreamPath(`${pathname}?x=1`), null);
    assert.equal(await closeCode(`${wsUrl}?x=1`), 1006);
    assert.equal(parseMediaStreamPath(`${pathname}/extra`), null);
    assert.equal(await closeCode(`${wsUrl}/extra`), 1006);
    assert.equal(bridges, 0);

    const socket = await openSocket(wsUrl);
    assert.equal(bridges, 1);
    assert.equal(await closeCode(wsUrl), 1008);
    assert.equal(bridges, 1);
    socket.terminate();
  });
});
