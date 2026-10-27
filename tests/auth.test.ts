import test from "node:test";
import assert from "node:assert/strict";

import { bearerMatches } from "../src/auth.js";
import { createApp } from "../src/http/server.js";
import { RateLimiter } from "../src/rate-limit.js";
import { summaryFromLog } from "../src/summary/payload.js";
import { sampleEntry, testConfig, tempStore } from "./fixtures.js";
import { withServer } from "./http-util.js";

test("bearer compare accepts only the exact token", () => {
  assert.equal(bearerMatches("Bearer test-messages-bearer", "test-messages-bearer"), true);
  assert.equal(bearerMatches("bearer test-messages-bearer", "test-messages-bearer"), true);
  assert.equal(bearerMatches("Bearer wrong-token-value", "test-messages-bearer"), false);
  assert.equal(bearerMatches("Bearer test-messages-bearar", "test-messages-bearer"), false);
  assert.equal(bearerMatches("Bearer test-messages-bearer extra", "test-messages-bearer"), false);
  assert.equal(bearerMatches(undefined, "test-messages-bearer"), false);
  assert.equal(bearerMatches("Bearer test-messages-bearer", undefined), false);
  assert.equal(bearerMatches("Basic test-messages-bearer", "test-messages-bearer"), false);
});

test("GET /health is open and GET /messages requires the bearer", async () => {
  const store = tempStore();
  const entry = sampleEntry();
  await store.append(entry, Date.parse("2026-10-10T12:00:00.000Z"));
  const app = createApp({ config: testConfig(), store });
  await withServer(app, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const missing = await fetch(`${base}/messages`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${base}/messages`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/messages?since=2026-10-01T00:00:00.000Z`, {
      headers: { authorization: "Bearer test-messages-bearer" },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { messages: [summaryFromLog(entry)] });

    const later = await fetch(`${base}/messages?since=2026-10-11T00:00:00.000Z`, {
      headers: { authorization: "Bearer test-messages-bearer" },
    });
    assert.equal(later.status, 200);
    assert.deepEqual(await later.json(), { messages: [] });

    const badSince = await fetch(`${base}/messages?since=not-a-date`, {
      headers: { authorization: "Bearer test-messages-bearer" },
    });
    assert.equal(badSince.status, 400);
  });
});

test("GET /messages is rate limited", async () => {
  const app = createApp({
    config: testConfig(),
    store: tempStore(),
    messagesLimiter: new RateLimiter(2, 60_000),
  });
  await withServer(app, async (base) => {
    const headers = { authorization: "Bearer test-messages-bearer" };
    assert.equal((await fetch(`${base}/messages`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/messages`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/messages`, { headers })).status, 429);
  });
});

test("production rate limits ignore a spoofed X-Forwarded-For", async () => {
  const app = createApp({
    config: testConfig({ production: true, nodeEnv: "production" }),
    store: tempStore(),
    messagesLimiter: new RateLimiter(1, 60_000),
  });
  await withServer(app, async (base) => {
    const headers = { authorization: "Bearer test-messages-bearer" };
    assert.equal((await fetch(`${base}/messages`, { headers })).status, 200);
    const spoofed = await fetch(`${base}/messages`, {
      headers: { ...headers, "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(spoofed.status, 429);
    const fly = await fetch(`${base}/messages`, {
      headers: { ...headers, "fly-client-ip": "203.0.113.10" },
    });
    assert.equal(fly.status, 200);
  });
});

test("voice webhook is rate limited before signature checks", async () => {
  const app = createApp({
    config: testConfig(),
    store: tempStore(),
    voiceLimiter: new RateLimiter(2, 60_000),
  });
  await withServer(app, async (base) => {
    const first = await fetch(`${base}/voice`, { method: "POST", body: "From=1" });
    const second = await fetch(`${base}/voice`, { method: "POST", body: "From=1" });
    const third = await fetch(`${base}/voice`, { method: "POST", body: "From=1" });
    assert.equal(first.status, 403);
    assert.equal(second.status, 403);
    assert.equal(third.status, 429);
  });
});
