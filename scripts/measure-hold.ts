/**
 * Measure whole-answer hold against the real xAI realtime socket and an
 * in-process Twilio socket. No Twilio call is placed.
 *
 * From the project root, with XAI_API_KEY set:
 *   npx tsc -p tsconfig.test.json && node dist-test/scripts/measure-hold.js results.json
 *
 * The key and request headers are never printed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import WebSocket from "ws";

import { attachBridge, type XaiSocketOptions } from "../src/bridge/attach.js";
import { XAI_REALTIME_URL } from "../src/bridge/protocol.js";
import { loadConfig } from "../src/config.js";
import { registerSecrets } from "../src/logger.js";

const QUESTIONS = [
  "What is this line?",
  "Who are you?",
  "Is he available right now?",
  "How can I reach him?",
  "What is Owner's ministry?",
  "Where can I read about the ministry?",
  "Can I leave a message?",
  "Is he free right now?",
  "What does his ministry do?",
  "How do I find exampleowner.org?",
  "Can you take a message for him?",
  "Tell me about his ministry work.",
];

interface Reply {
  question: string;
  responseId: string | null;
  tFirstAudio: number | null;
  tTextDone: number | null;
  tFirstMedia: number | null;
  sawDone: boolean;
  tripped: boolean;
}

interface ResultRow {
  question: string;
  response_id: string;
  hold_ms: number;
  wait_ms: number;
}

const origin = process.hrtime.bigint();

function nowMs(): number {
  return Number(process.hrtime.bigint() - origin) / 1_000_000;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function maximum(values: number[]): number {
  return values.reduce((best, value) => Math.max(best, value), values[0] ?? 0);
}

function rawToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return "";
}

function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : "measure-hold failed";
  const secret = process.env.XAI_API_KEY?.trim() ?? "";
  if (secret.length > 0 && text.includes(secret)) return text.split(secret).join("[redacted]");
  return text;
}

function responseIdOf(record: Record<string, unknown>): string | null {
  if (typeof record.response_id === "string" && record.response_id.length > 0) return record.response_id;
  const response = record.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const id = (response as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

function replyReady(reply: Reply): boolean {
  return reply.tFirstAudio !== null && reply.tTextDone !== null && reply.tFirstMedia !== null;
}

function waitUntil(ready: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (socketClosed && !stopping) {
        clearInterval(timer);
        reject(new Error("xAI realtime socket closed"));
        return;
      }
      if (ready()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(label));
      }
    }, 20);
  });
}

class FakeTwilio extends EventEmitter {
  readyState: number = WebSocket.OPEN;

  send(data: string): void {
    let event = "";
    try {
      const parsed = JSON.parse(data) as { event?: string };
      event = parsed.event ?? "";
    } catch {
      event = "";
    }
    if (event === "media") noteMedia();
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

let measuring = false;
let stopping = false;
let socketClosed = false;
let greetingMedia = 0;
let greetingDone = false;
let activeId: string | null = null;
let current: Reply | null = null;
let socket: WebSocket | null = null;

function noteMedia(): void {
  if (!measuring) {
    greetingMedia += 1;
    return;
  }
  if (!current || !activeId || current.responseId !== activeId || current.tFirstMedia !== null) return;
  current.tFirstMedia = nowMs();
}

function noteOutgoing(data: string): void {
  if (!measuring || !current) return;
  let parsed: { item?: { type?: string; content?: Array<{ text?: string }> } };
  try {
    parsed = JSON.parse(data) as { item?: { type?: string; content?: Array<{ text?: string }> } };
  } catch {
    return;
  }
  const text = parsed.item?.content?.[0]?.text ?? "";
  if (parsed.item?.type === "force_message" && text.includes("not allowed to give that kind of information")) {
    current.tripped = true;
  }
}

function claim(id: string): boolean {
  if (!current) return false;
  if (!current.responseId) current.responseId = id;
  return current.responseId === id;
}

function observeIncoming(raw: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (!measuring) {
    if (type === "response.done") greetingDone = true;
    return;
  }
  if (!current) return;
  const id = responseIdOf(parsed);
  if ((type === "response.output_audio.delta" || type === "response.audio.delta") && id && claim(id)) {
    if (current.tFirstAudio === null) current.tFirstAudio = nowMs();
    return;
  }
  if (type === "response.output_audio_transcript.done" && id && claim(id)) {
    if (current.tTextDone === null) current.tTextDone = nowMs();
    activeId = id;
    return;
  }
  if (type === "response.done" && id && current.responseId === id) current.sawDone = true;
}

function connectXai(url: string, options: XaiSocketOptions): WebSocket {
  if (url !== XAI_REALTIME_URL) throw new Error("unexpected realtime url");
  const ws = new WebSocket(url, options);
  ws.on("message", (data) => {
    observeIncoming(rawToString(data));
  });
  const origSend = ws.send.bind(ws);
  const sendWrapped = (data: Parameters<WebSocket["send"]>[0]): void => {
    if (typeof data === "string") noteOutgoing(data);
    else if (Buffer.isBuffer(data)) noteOutgoing(data.toString("utf8"));
    origSend(data);
  };
  ws.send = sendWrapped as typeof ws.send;
  ws.on("close", () => {
    if (!stopping) socketClosed = true;
  });
  socket = ws;
  return ws;
}

function sendQuestion(ws: WebSocket, text: string): void {
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    }),
  );
  ws.send(JSON.stringify({ type: "response.create" }));
}

async function main(): Promise<number> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: node dist-test/scripts/measure-hold.js <results.json>");
    return 1;
  }
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    console.error("XAI_API_KEY is not set");
    return 1;
  }
  registerSecrets([key]);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-hold-"));
  const twilio = new FakeTwilio();
  try {
    const config = loadConfig({ ...process.env, XAI_API_KEY: key, DATA_DIR: dataDir, MAX_CALL_MS: "900000" });
    if (!fs.existsSync(config.greetingsConfigPath)) {
      throw new Error("greeting catalog was not found; run from the project root");
    }
    attachBridge({
      twilio: twilio as unknown as WebSocket,
      config,
      callSid: "CA_MEASURE",
      callerNumber: "+15555550100",
      flags: [],
      startedAtMs: Date.now(),
      onComplete: () => {
        /* call log stays on disk in the temp dir, which is removed on exit */
      },
      connectXai,
      sessionReadyMs: 30_000,
    });
    twilio.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event: "start",
          streamSid: "MZMEASURE",
          start: { streamSid: "MZMEASURE", callSid: "CA_MEASURE" },
        }),
      ),
    );
    await waitUntil(() => greetingDone && greetingMedia > 0, 45_000, "greeting did not finish");
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("xAI socket is not open");
    measuring = true;
    const rows: ResultRow[] = [];
    for (const question of QUESTIONS) {
      activeId = null;
      current = {
        question,
        responseId: null,
        tFirstAudio: null,
        tTextDone: null,
        tFirstMedia: null,
        sawDone: false,
        tripped: false,
      };
      sendQuestion(socket, question);
      await waitUntil(
        () => current !== null && (current.tripped || (current.sawDone && replyReady(current))),
        40_000,
        `no measurement for: ${question}`,
      );
      if (!current || current.tripped) throw new Error(`guardrail tripped for: ${question}`);
      if (!replyReady(current) || !current.responseId || current.tFirstMedia === null || current.tTextDone === null || current.tFirstAudio === null) {
        throw new Error(`incomplete measurement for: ${question}`);
      }
      const holdMs = roundMs(current.tFirstMedia - current.tTextDone);
      const waitMs = roundMs(current.tFirstMedia - current.tFirstAudio);
      if (!Number.isFinite(holdMs) || !Number.isFinite(waitMs)) throw new Error(`bad timestamps for: ${question}`);
      rows.push({ question, response_id: current.responseId, hold_ms: holdMs, wait_ms: waitMs });
      console.log(`${rows.length} hold_ms=${holdMs} wait_ms=${waitMs}`);
    }
    const holdValues = rows.map((row) => row.hold_ms);
    const waitValues = rows.map((row) => row.wait_ms);
    const report = {
      n: rows.length,
      replies: rows,
      hold_ms: { median: roundMs(median(holdValues)), max: roundMs(maximum(holdValues)) },
      wait_ms: { median: roundMs(median(waitValues)), max: roundMs(maximum(waitValues)) },
    };
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      `n=${report.n} hold_ms median=${report.hold_ms.median} max=${report.hold_ms.max} wait_ms median=${report.wait_ms.median} max=${report.wait_ms.max}`,
    );
    return 0;
  } finally {
    stopping = true;
    try {
      twilio.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(safeError(err));
    process.exit(1);
  });
