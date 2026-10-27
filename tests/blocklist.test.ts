import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/http/server.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import { RepeatTracker, screenCaller } from "../src/twilio/policy.js";
import { testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

function writeLists(allowlist: string[], blocklist: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callers-"));
  const file = path.join(dir, "callers.json");
  fs.writeFileSync(file, JSON.stringify({ allowlist, blocklist }));
  return file;
}

test("blocklist hangs up, allowlist is flagged, unknown callers connect", () => {
  const lists = { allowlist: ["+15551110000"], blocklist: ["2025550100"] };
  const repeat = new RepeatTracker(5, 600_000);
  const blocked = screenCaller("+1 (202) 555-0100", lists, repeat);
  assert.equal(blocked.action, "block");
  assert.deepEqual(blocked.flags, ["blocked"]);

  const allowed = screenCaller("5551110000", lists, repeat);
  assert.equal(allowed.action, "connect");
  assert.deepEqual(allowed.flags, ["allowlisted"]);
  assert.equal(allowed.callerNumber, "+15551110000");

  const unknown = screenCaller("+15552220000", lists, repeat);
  assert.equal(unknown.action, "connect");
  assert.deepEqual(unknown.flags, []);

  const anon = screenCaller("anonymous", lists, repeat);
  assert.equal(anon.action, "spam");
  assert.equal(anon.callerNumber, null);

  const short = screenCaller("555", lists, repeat);
  assert.equal(short.action, "spam");
  const huge = screenCaller(`+1555${"1".repeat(80)}`, lists, repeat);
  assert.equal(huge.action, "spam");
});

test("blocklist wins when a number is on both lists", () => {
  const lists = { allowlist: ["+15551110000"], blocklist: ["+15551110000"] };
  const result = screenCaller("+15551110000", lists, new RepeatTracker(5, 600_000));
  assert.equal(result.action, "block");
});

test("allowlisted callers are not treated as repeat spam", () => {
  const lists = { allowlist: ["+15551110000"], blocklist: [] };
  const repeat = new RepeatTracker(1, 600_000);
  assert.equal(screenCaller("+15551110000", lists, repeat).action, "connect");
  assert.equal(screenCaller("+15551110000", lists, repeat).action, "connect");
});

test("repeat callers past the limit get a spam hangup", () => {
  const lists = { allowlist: [], blocklist: [] };
  const repeat = new RepeatTracker(2, 600_000);
  assert.equal(screenCaller("+15553330000", lists, repeat).action, "connect");
  assert.equal(screenCaller("+15553330000", lists, repeat).action, "connect");
  const third = screenCaller("+15553330000", lists, repeat);
  assert.equal(third.action, "spam");
  assert.deepEqual(third.flags, ["spam"]);
});

test("blocklisted webhook returns a polite hangup and logs the call", async () => {
  const callers = writeLists([], ["+15554440000"]);
  const store = tempStore();
  const config = testConfig({ callersConfigPath: callers });
  const app = createApp({ config, store });
  const params = { CallSid: "CA999", From: "+15554440000", To: "+12025550123" };
  const signature = computeTwilioSignature("test-auth-token", "https://example.com/voice", params);
  await withServer(app, async (base) => {
    const result = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(result.status, 200);
    assert.match(result.text, /<Hangup\/>/);
    assert.match(result.text, /Sorry, this number cannot take your call/);
    assert.doesNotMatch(result.text, /<Stream/);
    assert.doesNotMatch(result.text, /<Dial/);
    assert.doesNotMatch(result.text, /<Record/);
  });
  const rows = await store.readSince();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.disposition, "blocked");
  assert.deepEqual(rows[0]?.flags, ["blocked"]);
  assert.equal(rows[0]?.message.name, null);
  assert.equal(rows[0]?.caller_number, "+15554440000");
});
