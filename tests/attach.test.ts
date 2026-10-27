import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { attachBridge, type XaiSocketOptions } from "../src/bridge/attach.js";
import { XAI_REALTIME_URL } from "../src/bridge/protocol.js";
import { testConfig } from "./fixtures.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closed = false;

  send(data: string): void {
    void data;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function bridgePair(opts: { sessionReadyMs?: number; onComplete?: () => void } = {}): {
  twilio: FakeSocket;
  xai: FakeSocket;
  seenUrl: string;
  seenAuth: string;
} {
  const twilio = new FakeSocket();
  const xai = new FakeSocket();
  let seenUrl = "";
  let seenAuth = "";
  attachBridge({
    twilio: twilio as unknown as WebSocket,
    config: testConfig(),
    callSid: "CA1",
    callerNumber: "+15551212000",
    flags: [],
    startedAtMs: Date.parse("2026-10-10T15:00:00.000Z"),
    onComplete: () => {
      opts.onComplete?.();
    },
    sessionReadyMs: opts.sessionReadyMs ?? 60_000,
    connectXai: (url: string, options: XaiSocketOptions) => {
      seenUrl = url;
      seenAuth = options.headers.Authorization;
      return xai as unknown as WebSocket;
    },
  });
  return { twilio, xai, get seenUrl() { return seenUrl; }, get seenAuth() { return seenAuth; } };
}

test("the bridge opens xAI with the bearer key and closes both sockets once", () => {
  let completes = 0;
  const pair = bridgePair({ onComplete: () => { completes += 1; } });
  assert.equal(pair.seenUrl, XAI_REALTIME_URL);
  assert.equal(pair.seenAuth, "Bearer test-xai-key");
  pair.xai.emit("open");
  pair.xai.emit("message", JSON.stringify({ type: "session.updated" }));
  pair.twilio.emit("close");
  assert.equal(completes, 1);
  assert.equal(pair.xai.closed, true);
  assert.equal(pair.twilio.closed, true);
  pair.xai.emit("close");
  assert.equal(completes, 1);
});

test("a session that never becomes ready ends the call", async () => {
  let completes = 0;
  const pair = bridgePair({ sessionReadyMs: 20, onComplete: () => { completes += 1; } });
  pair.xai.emit("open");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(completes, 1);
  assert.equal(pair.twilio.closed, true);
  assert.equal(pair.xai.closed, true);
});
