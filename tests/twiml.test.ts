import test from "node:test";
import assert from "node:assert/strict";

import { GREETING, spokenGreeting } from "../src/bridge/protocol.js";
import { connectStreamTwiml, hangupTwiml } from "../src/twilio/twiml.js";
import { mediaStreamUrl } from "../src/twilio/stream-token.js";

test("greeting text is exact", () => {
  assert.equal(GREETING, "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?");
  assert.equal(spokenGreeting(false), GREETING);
  assert.equal(spokenGreeting(true), "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?");
});

test("connect twiml is a media stream and never a recording or dial", () => {
  const from = "+15551212000";
  const url = mediaStreamUrl("https://example.com", {
    exp: "1700000000",
    callSid: "CA123",
    from,
    t: "1700000000000",
    token: "abc",
  });
  const encodedFrom = Buffer.from(from, "utf8").toString("base64url");
  assert.equal(url, `wss://example.com/media-stream/CA123/1700000000/1700000000000/${encodedFrom}/abc`);
  assert.equal(url.includes("?"), false);
  assert.equal(url.includes("+"), false);
  const tricky = mediaStreamUrl("https://example.com", {
    exp: "1700000000",
    callSid: "CA123",
    from: ">>>",
    t: "1700000000000",
    token: "abc",
  });
  assert.equal(tricky, "wss://example.com/media-stream/CA123/1700000000/1700000000000/Pj4-/abc");
  assert.equal(tricky.includes("?"), false);
  const xml = connectStreamTwiml(url);
  assert.match(xml, /<Connect>/);
  assert.match(xml, /<Stream url="wss:\/\/example\.com\/media-stream\/CA123\//);
  const stream = /<Stream url="([^"]+)"/.exec(xml)?.[1] ?? "";
  assert.equal(stream.includes("?"), false);
  assert.doesNotMatch(xml, /<Record[\s>/]/);
  assert.doesNotMatch(xml, /<Dial[\s>/]/);
  assert.doesNotMatch(xml, /<Say[\s>]/);
});

test("hangup twiml says goodbye and does not open a stream", () => {
  const xml = hangupTwiml("Sorry, this number cannot take your call. Goodbye.");
  assert.match(xml, /<Hangup\/>/);
  assert.match(xml, /<Say>/);
  assert.doesNotMatch(xml, /<Connect>/);
  assert.doesNotMatch(xml, /<Record/);
  const escaped = hangupTwiml(`Tom & Jerry <admin>`);
  assert.match(escaped, /Tom &amp; Jerry &lt;admin&gt;/);
});
