import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/http/server.js";
import {
  computeTwilioSignature,
  publicOriginError,
  signatureDecision,
  validateTwilioSignature,
} from "../src/twilio/signature.js";
import { testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

const TOKEN = "test-auth-token";
const URL = "https://example.com/voice";
const PARAMS = { CallSid: "CA123", From: "+15551212", To: "+12025550123" };
const EXPECTED = "qm8GcIuMJ/1h+z/eReD9r58YJM8=";

test("twilio signature matches the known HMAC-SHA1 vector", () => {
  assert.equal(computeTwilioSignature(TOKEN, URL, PARAMS), EXPECTED);
  assert.equal(validateTwilioSignature(TOKEN, EXPECTED, URL, PARAMS), true);
  assert.equal(validateTwilioSignature(TOKEN, "not-the-signature", URL, PARAMS), false);
  assert.equal(validateTwilioSignature(TOKEN, undefined, URL, PARAMS), false);
  assert.equal(validateTwilioSignature(TOKEN, EXPECTED, `${URL}?x=1`, PARAMS), false);
});

test("signature fails closed when the auth token is missing", () => {
  assert.equal(
    signatureDecision({
      production: true,
      authToken: undefined,
      allowInsecureDev: true,
      signature: undefined,
      url: URL,
      params: {},
    }),
    "rejected",
  );
  assert.equal(
    signatureDecision({
      production: false,
      authToken: undefined,
      allowInsecureDev: false,
      signature: undefined,
      url: URL,
      params: {},
    }),
    "rejected",
  );
  assert.equal(
    signatureDecision({
      production: false,
      authToken: undefined,
      allowInsecureDev: true,
      signature: undefined,
      url: URL,
      params: {},
    }),
    "ok",
  );
});

test("voice webhook rejects an invalid signature and accepts a valid one", async () => {
  const config = testConfig();
  const app = createApp({ config, store: tempStore() });
  await withServer(app, async (base) => {
    const params = { CallSid: "CA123", From: "+15551212000", To: "+12025550123" };
    const bad = await postForm(`${base}/voice`, params, { "x-twilio-signature": "nope" });
    assert.equal(bad.status, 403);

    const goodSig = computeTwilioSignature(TOKEN, "https://example.com/voice", params);
    const good = await postForm(`${base}/voice`, params, { "x-twilio-signature": goodSig });
    assert.equal(good.status, 200);
    assert.match(good.text, /<Connect>/);
    assert.match(good.text, /<Stream /);
    assert.doesNotMatch(good.text, /<Record/);
    assert.doesNotMatch(good.text, /<Dial/);
  });
});

test("production requires PUBLIC_BASE_URL and ignores a forwarded host", async () => {
  assert.equal(publicOriginError(undefined, true), "missing");
  assert.equal(publicOriginError("https://example.com", true), null);
  assert.equal(publicOriginError("http://example.com", true), "insecure");
  assert.equal(publicOriginError("https://example.com/voice", true), "path");

  const missing = testConfig({
    production: true,
    nodeEnv: "production",
    publicBaseUrl: undefined,
  });
  const missingApp = createApp({ config: missing, store: tempStore() });
  await withServer(missingApp, async (base) => {
    const params = { CallSid: "CA123", From: "+15551212000" };
    const signature = computeTwilioSignature(TOKEN, "https://evil.example/voice", params);
    const result = await postForm(`${base}/voice`, params, {
      "x-twilio-signature": signature,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    assert.equal(result.status, 403);
  });

  const pinned = testConfig({ production: true, nodeEnv: "production" });
  const pinnedApp = createApp({ config: pinned, store: tempStore() });
  await withServer(pinnedApp, async (base) => {
    const params = { CallSid: "CA777", From: "+15551212000", To: "+12025550123" };
    const evil = computeTwilioSignature(TOKEN, "https://evil.example/voice", params);
    const rejected = await postForm(`${base}/voice`, params, {
      "x-twilio-signature": evil,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });
    assert.equal(rejected.status, 403);

    const goodSig = computeTwilioSignature(TOKEN, "https://example.com/voice", params);
    const accepted = await postForm(`${base}/voice`, params, {
      "x-twilio-signature": goodSig,
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    });
    assert.equal(accepted.status, 200);
    assert.match(accepted.text, /wss:\/\/example\.com\/media-stream/);
    assert.doesNotMatch(accepted.text, /test-auth-token/);
    assert.doesNotMatch(accepted.text, /test-xai-key/);
  });
});

test("production http origin hangs up instead of opening a cleartext stream", async () => {
  const config = testConfig({
    production: true,
    nodeEnv: "production",
    publicBaseUrl: "http://example.com",
  });
  const app = createApp({ config, store: tempStore() });
  await withServer(app, async (base) => {
    const params = { CallSid: "CA778", From: "+15551212000", To: "+12025550123" };
    const signature = computeTwilioSignature(TOKEN, "http://example.com/voice", params);
    const result = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(result.status, 200);
    assert.match(result.text, /<Hangup\/>/);
    assert.doesNotMatch(result.text, /<Stream/);
  });
});

test("production webhook rejects unsigned requests even if insecure dev is set", async () => {
  const config = testConfig({
    production: true,
    nodeEnv: "production",
    twilioAuthToken: undefined,
    allowInsecureDevWebhook: true,
  });
  const app = createApp({ config, store: tempStore() });
  await withServer(app, async (base) => {
    const result = await postForm(`${base}/voice`, { CallSid: "CA123", From: "+15551212000" });
    assert.equal(result.status, 403);
  });
});
