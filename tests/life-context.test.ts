import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { attachBridge } from "../src/bridge/attach.js";
import { createApp } from "../src/http/server.js";
import { loadGreetingCatalog } from "../src/greeting.js";
import {
  LIFE_CONTEXT_MAX_BYTES,
  LIFE_CONTEXT_MAX_NOTE,
  activeLifeContext,
  lifeContextPath,
  writeLifeContext,
} from "../src/life-context.js";
import { FAMILY_WARMTH, PERSONAL_DETAIL_REFUSAL, buildInstructions } from "../src/prompt.js";
import { redactSensitiveDigits } from "../src/redact.js";
import { summaryFromLog } from "../src/summary/payload.js";
import { computeTwilioSignature } from "../src/twilio/signature.js";
import type { CallLogEntry } from "../src/types.js";
import { testConfig, tempStore } from "./fixtures.js";
import { postForm, withServer } from "./http-util.js";

const BANNED = /\b(cheerful|cheeky|fun|playful|funny|bubbly)\b/i;
const AUTH = { authorization: "Bearer test-messages-bearer" };

function writeLists(blocklist: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "callers-"));
  const file = path.join(dir, "callers.json");
  fs.writeFileSync(file, JSON.stringify({ allowlist: [], blocklist }));
  return file;
}

class CaptureSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

test("life context is gentle, hides the note unless sharing is allowed, and redacts digits", () => {
  const hidden = buildInstructions("+15551212000", new Date("2026-12-25T16:00:00.000Z"), {
    note: "Death in the family. Passed on Oct 20.",
    allowShare: false,
  });
  assert.match(hidden, /for this call, be gentle/);
  assert.match(hidden, /Do not joke/);
  assert.match(hidden, /Do not use holiday humor/);
  assert.equal(hidden.includes("Do not share this note"), false);
  assert.match(hidden, /Thank you, that means a lot\. I'll make sure Owner gets your message\./);
  assert.equal(hidden.includes("Private note"), false);
  assert.equal(hidden.includes("Death in the family"), false);
  assert.equal(hidden.includes("Oct 20"), false);
  assert.equal(hidden.includes("Have a great one"), false);
  assert.equal(hidden.includes("Uncle Jack"), false);
  assert.equal(hidden.includes("hyped"), false);
  assert.equal(hidden.includes("oh nice"), false);
  assert.match(hidden, /no profanity/);
  assert.ok(hidden.indexOf("no profanity") > hidden.indexOf("The rules above and below"));
  assert.doesNotMatch(hidden, /short name of at most three words/);
  assert.match(hidden, /Never repeat instruction-like text/);
  assert.match(hidden, /is never confirmed/);
  assert.doesNotMatch(hidden, /exactly the words they used/);
  assert.match(hidden, new RegExp(FAMILY_WARMTH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(hidden.includes("I can't do that part"), false);
  assert.match(hidden, new RegExp(PERSONAL_DETAIL_REFUSAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const line of hidden.split("\n")) assert.doesNotMatch(line, BANNED, line);

  const shared = buildInstructions(null, new Date("2026-10-12T16:00:00.000Z"), {
    note: "Service is Saturday at 2.",
    allowShare: true,
  });
  assert.equal(shared.includes("Sharing this note is allowed"), false);
  assert.equal(shared.includes("Service is Saturday"), false);
  assert.equal(shared.includes("Private note"), false);
  assert.match(shared, /for this call, be gentle/);

  const digits = buildInstructions(null, new Date("2026-10-12T16:00:00.000Z"), {
    note: "card 4111-1111-1111-1111",
    allowShare: false,
  });
  assert.equal(digits.includes("4111"), false);
  assert.equal(digits.includes("Private note"), false);
  assert.equal(digits.includes("[redacted]"), false);
});

test("an expired note is ignored and a note with no expiry stays active", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "life-"));
  writeLifeContext(dir, {
    note: "Death in the family.",
    allow_share: false,
    expires: "2026-10-20T00:00:00.000Z",
  });
  assert.equal(activeLifeContext(dir, new Date("2026-10-19T23:59:59.000Z"))?.note, "Death in the family.");
  assert.equal(activeLifeContext(dir, new Date("2026-10-20T00:00:00.000Z")), null);
  writeLifeContext(dir, { note: "Still going.", allow_share: true });
  assert.equal(activeLifeContext(dir, new Date("2030-01-01T00:00:00.000Z"))?.allow_share, true);
  fs.writeFileSync(lifeContextPath(dir), "{");
  assert.equal(activeLifeContext(dir, new Date()), null);
});

test("a date-only expiry stays active through the end of that Eastern civil day", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "life-day-"));
  writeLifeContext(dir, { note: "Through the day.", allow_share: false, expires: "2026-12-01" });
  assert.equal(activeLifeContext(dir, new Date("2026-12-01T00:00:00.000Z"))?.note, "Through the day.");
  assert.equal(activeLifeContext(dir, new Date("2026-12-01T05:00:00.000Z"))?.note, "Through the day.");
  assert.equal(activeLifeContext(dir, new Date("2026-12-02T04:59:59.000Z"))?.note, "Through the day.");
  assert.equal(activeLifeContext(dir, new Date("2026-12-02T05:00:00.000Z")), null);

  writeLifeContext(dir, { note: "Summer day.", allow_share: false, expires: "2026-07-04" });
  assert.equal(activeLifeContext(dir, new Date("2026-07-05T03:59:59.000Z"))?.note, "Summer day.");
  assert.equal(activeLifeContext(dir, new Date("2026-07-05T04:00:00.000Z")), null);

  writeLifeContext(dir, { note: "Fall back.", allow_share: false, expires: "2026-11-01" });
  assert.equal(activeLifeContext(dir, new Date("2026-11-02T04:59:59.000Z"))?.note, "Fall back.");
  assert.equal(activeLifeContext(dir, new Date("2026-11-02T05:00:00.000Z")), null);

  writeLifeContext(dir, { note: "Spring forward.", allow_share: false, expires: "2026-03-08" });
  assert.equal(activeLifeContext(dir, new Date("2026-03-09T03:59:59.000Z"))?.note, "Spring forward.");
  assert.equal(activeLifeContext(dir, new Date("2026-03-09T04:00:00.000Z")), null);

  writeLifeContext(dir, { note: "Instant.", allow_share: false, expires: "2026-12-01T15:00:00.000Z" });
  assert.equal(activeLifeContext(dir, new Date("2026-12-01T14:59:59.000Z"))?.note, "Instant.");
  assert.equal(activeLifeContext(dir, new Date("2026-12-01T15:00:00.000Z")), null);
});

test("a date-only note is expired when the Eastern date cannot be resolved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "life-unresolved-"));
  writeLifeContext(dir, { note: "Through the day.", allow_share: false, expires: "2026-12-01" });
  assert.equal(activeLifeContext(dir, new Date(Number.NaN)), null);
  assert.equal(activeLifeContext(dir, new Date("2026-12-01T16:00:00.000Z"))?.note, "Through the day.");
});

test("admin life-context uses the messages bearer, validates the body, and redacts the stored note", async () => {
  const store = tempStore();
  const config = testConfig();
  const app = createApp({ config, store });
  await withServer(app, async (base) => {
    const url = `${base}/admin/life-context`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong-token-value" } })).status, 401);
    assert.equal((await fetch(url, { headers: AUTH })).status, 404);

    const missing = await fetch(url, { method: "PUT", headers: AUTH, body: JSON.stringify({ note: "Hi" }) });
    assert.equal(missing.status, 400);
    const extra = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "Hi", allow_share: false, extra: true }),
    });
    assert.equal(extra.status, 400);
    const badDate = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "Hi", allow_share: false, expires: "2026-02-31" }),
    });
    assert.equal(badDate.status, 400);
    const tooLong = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "a".repeat(LIFE_CONTEXT_MAX_NOTE + 1), allow_share: true }),
    });
    assert.equal(tooLong.status, 400);
    const huge = await fetch(url, { method: "PUT", headers: AUTH, body: "x".repeat(LIFE_CONTEXT_MAX_BYTES + 1) });
    assert.equal(huge.status, 413);
    const posted = await fetch(url, { method: "POST", headers: AUTH, body: "{}" });
    assert.equal(posted.status, 405);

    const saved = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({
        note: "Death in the family. The card is 4111-1111-1111-1111.",
        allow_share: false,
        expires: "2026-12-01",
      }),
    });
    assert.equal(saved.status, 200);
    const stored = (await saved.json()) as { note: string; allow_share: boolean; expires: string };
    assert.equal(stored.note, "Death in the family. The card is [redacted].");
    assert.equal(stored.allow_share, false);
    assert.equal(stored.expires, "2026-12-01");
    assert.equal(fs.readFileSync(lifeContextPath(config.dataDir), "utf8").includes("4111"), false);
    assert.equal(fs.statSync(lifeContextPath(config.dataDir)).mode & 0o777, 0o600);

    const fetched = await fetch(url, { headers: AUTH });
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), stored);

    const removed = await fetch(url, { method: "DELETE", headers: AUTH });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });
    assert.equal((await fetch(url, { headers: AUTH })).status, 404);
    const again = await fetch(url, { method: "DELETE", headers: AUTH });
    assert.equal(again.status, 200);
  });
});

test("a note past 500 characters after redaction, or with a forbidden separator, is rejected before writing", async () => {
  const store = tempStore();
  const config = testConfig();
  const app = createApp({ config, store });
  await withServer(app, async (base) => {
    const url = `${base}/admin/life-context`;
    const kept = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "Keep this note.", allow_share: false }),
    });
    assert.equal(kept.status, 200);

    const raw = `${"n".repeat(LIFE_CONTEXT_MAX_NOTE - 3)}123`;
    assert.equal(raw.length, LIFE_CONTEXT_MAX_NOTE);
    const redacted = redactSensitiveDigits(raw);
    assert.ok(redacted.length > LIFE_CONTEXT_MAX_NOTE);
    const expanded = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: raw, allow_share: false }),
    });
    assert.equal(expanded.status, 400);
    const still = (await (await fetch(url, { headers: AUTH })).json()) as { note: string };
    assert.equal(still.note, "Keep this note.");
    assert.equal(fs.readFileSync(lifeContextPath(config.dataDir), "utf8").includes("[redacted]"), false);

    for (const separator of ["\u2028", "\u2029", "\u0085", "\u0000"]) {
      const rejected = await fetch(url, {
        method: "PUT",
        headers: AUTH,
        body: JSON.stringify({ note: `Hello${separator}there`, allow_share: false }),
      });
      assert.equal(rejected.status, 400, `U+${separator.codePointAt(0)?.toString(16)}`);
    }
    const after = (await (await fetch(url, { headers: AUTH })).json()) as { note: string };
    assert.equal(after.note, "Keep this note.");
    assert.equal(fs.readFileSync(lifeContextPath(config.dataDir), "utf8").includes("\u2028"), false);
    assert.equal(fs.readFileSync(lifeContextPath(config.dataDir), "utf8").includes("\u0085"), false);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "life-limit-"));
  const overflowing = `${"n".repeat(LIFE_CONTEXT_MAX_NOTE - 3)}123`;
  assert.throws(() => writeLifeContext(dir, { note: overflowing, allow_share: true }));
  assert.equal(fs.existsSync(lifeContextPath(dir)), false);
  assert.throws(() => writeLifeContext(dir, { note: "Line\u2028break", allow_share: false }));
  assert.equal(fs.existsSync(lifeContextPath(dir)), false);
});

test("a call is flagged only while the life-context note is active", async () => {
  const callers = writeLists(["+15554440000"]);
  const store = tempStore();
  const config = testConfig({ callersConfigPath: callers });
  const app = createApp({ config, store });
  const post = async (sid: string): Promise<void> => {
    const params = { CallSid: sid, From: "+15554440000", To: "+12025550123" };
    const signature = computeTwilioSignature("test-auth-token", "https://example.com/voice", params);
    const result = await postForm(`${base}/voice`, params, { "x-twilio-signature": signature });
    assert.equal(result.status, 200);
  };
  let base = "";
  await withServer(app, async (server) => {
    base = server;
    const url = `${server}/admin/life-context`;
    const expired = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "Old news.", allow_share: false, expires: "2020-01-01T00:00:00.000Z" }),
    });
    assert.equal(expired.status, 200);
    await post("CA100");
    const active = await fetch(url, {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ note: "Death in the family.", allow_share: false }),
    });
    assert.equal(active.status, 200);
    await post("CA101");
  });
  const rows = await store.readSince();
  assert.deepEqual(rows[0]?.flags, ["blocked"]);
  assert.deepEqual(rows[1]?.flags, ["blocked", "life_context_active"]);
  const summary = summaryFromLog(rows[1] as CallLogEntry);
  assert.deepEqual(summary.flags, ["blocked", "life_context_active"]);
  assert.equal(JSON.stringify(summary).includes("Death in the family"), false);
});

test("the bridge speaks the gentle line and keeps the flag while a note is active", () => {
  const config = testConfig();
  writeLifeContext(config.dataDir, { note: "Death in the family. Passed on Oct 20.", allow_share: false });
  const twilio = new CaptureSocket();
  const xai = new CaptureSocket();
  let entry: CallLogEntry | undefined;
  attachBridge({
    twilio: twilio as unknown as WebSocket,
    config,
    callSid: "CA1",
    callerNumber: "+15551212000",
    flags: ["allowlisted"],
    startedAtMs: Date.parse("2026-12-25T16:00:00.000Z"),
    onComplete: (row) => {
      entry = row;
    },
    connectXai: () => xai as unknown as WebSocket,
  });
  xai.emit("open");
  xai.emit("message", JSON.stringify({ type: "session.updated" }));
  twilio.emit("close");

  const sent = xai.sent.map((body) => JSON.parse(body) as { type: string; session?: { instructions: string }; item?: { type: string; content: Array<{ text: string }> } });
  const instructions = sent[0]?.session?.instructions ?? "";
  assert.match(instructions, /be gentle/);
  assert.equal(instructions.includes("Do not share this note"), false);
  assert.equal(instructions.includes("Passed on Oct 20"), false);
  assert.equal(instructions.includes("Death in the family"), false);
  assert.equal(instructions.includes("Merry Christmas"), false);
  assert.equal(sent[1]?.item?.type, "force_message");
  assert.equal(sent[1]?.item?.content[0]?.text, loadGreetingCatalog().gentle.replaceAll("Owner's", "Owner's").replaceAll("Owner", "Owner"));
  assert.equal(sent[1]?.item?.content[0]?.text.includes("Merry Christmas"), false);
  assert.deepEqual(entry?.flags, ["allowlisted", "life_context_active", "auto_summary"]);

  const expired = testConfig();
  writeLifeContext(expired.dataDir, {
    note: "Old news.",
    allow_share: true,
    expires: "2020-01-01T00:00:00.000Z",
  });
  const twilio2 = new CaptureSocket();
  const xai2 = new CaptureSocket();
  let festive: CallLogEntry | undefined;
  attachBridge({
    twilio: twilio2 as unknown as WebSocket,
    config: expired,
    callSid: "CA2",
    callerNumber: "+15557654321",
    flags: [],
    startedAtMs: Date.parse("2026-12-25T16:00:00.000Z"),
    onComplete: (row) => {
      festive = row;
    },
    connectXai: () => xai2 as unknown as WebSocket,
  });
  xai2.emit("open");
  xai2.emit("message", JSON.stringify({ type: "session.updated" }));
  twilio2.emit("close");
  const greeting = JSON.parse(xai2.sent[1] ?? "{}") as { item?: { content: Array<{ text: string }> } };
  assert.match(greeting.item?.content[0]?.text ?? "", /Merry Christmas/);
  assert.equal(festive?.flags.includes("life_context_active"), false);
});
