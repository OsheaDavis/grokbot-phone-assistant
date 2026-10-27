import { execFileSync, spawnSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { LookupFunction } from "node:net";

import { loadConfig } from "../src/config.js";
import { deliverSummary, summaryAuthorizationValue } from "../src/summary/deliver.js";
import { serializeSummary, summaryFromLog, summaryShapeError } from "../src/summary/payload.js";
import { signSummary, verifySummary } from "../src/summary/sign.js";
import type { CallSummary } from "../src/types.js";
import { sampleEntry } from "./fixtures.js";

/**
 * The pin tests bind 203.0.113.10, a documentation address with no host route.
 * When this process cannot bind it, re-run in a user network namespace where
 * that address is added to loopback. Delivery code is unchanged.
 */
const PIN_ADDRESS = "203.0.113.10";

function canBindHost(host: string): boolean {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(0,${JSON.stringify(host)},()=>{s.close(()=>process.exit(0));});setTimeout(()=>process.exit(1),2000);`,
    ],
    { encoding: "utf8" },
  );
  return probe.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (process.env.SUMMARY_PIN_NETNS !== "1" && !canBindHost(PIN_ADDRESS)) {
  const command = [
    "ip link set lo up",
    `ip addr add ${PIN_ADDRESS}/32 dev lo`,
    `exec ${shellQuote(process.execPath)} ${process.argv.slice(1).map(shellQuote).join(" ")}`,
  ].join(" && ");
  const child = spawnSync("unshare", ["--user", "--map-root-user", "--net", "bash", "-c", command], {
    stdio: "inherit",
    env: { ...process.env, SUMMARY_PIN_NETNS: "1" },
  });
  process.exit(child.status ?? 1);
}

const FIXTURE: CallSummary = {
  caller_number: "+15551212000",
  name: "Jane Doe",
  callback_number: "+15551212000",
  reason: "Asking about a Saturday pickup.",
  transcript_summary: "Caller: This is Jane.\nAssistant: Owner isn't available; I can take a message.",
  questions: [],
  start_time: "2026-10-10T15:04:05.000Z",
  end_time: "2026-10-10T15:06:41.000Z",
  flags: [],
  urgent: false,
};

const EXPECTED_BODY =
  '{"caller_number":"+15551212000","name":"Jane Doe","callback_number":"+15551212000","reason":"Asking about a Saturday pickup.","transcript_summary":"Caller: This is Jane.\\nAssistant: Owner isn\'t available; I can take a message.","questions":[],"start_time":"2026-10-10T15:04:05.000Z","end_time":"2026-10-10T15:06:41.000Z","flags":[],"urgent":false}';

const EXPECTED_SIG = "431bdbc10ecc4086fa686d66ef870787f25a3611ec7ab721ecf69d8cad10930c";

test("summary payload shape and canonical JSON", () => {
  const body = serializeSummary(FIXTURE);
  assert.equal(body, EXPECTED_BODY);
  assert.equal(summaryShapeError(JSON.parse(body) as unknown), null);
  const sorted = serializeSummary({ ...FIXTURE, flags: ["spam", "allowlisted"] });
  assert.match(sorted, /"flags":\["allowlisted","spam"\]/);
  assert.equal(summaryShapeError({ ...FIXTURE, extra: true }), "unexpected extra");
  assert.equal(summaryShapeError({ ...FIXTURE, flags: ["nope"] }), "unknown flag");
  const missing: Record<string, unknown> = { ...FIXTURE };
  delete missing.reason;
  assert.equal(summaryShapeError(missing), "missing reason");
  assert.equal(summaryShapeError({ ...FIXTURE, start_time: "yesterday" }), "start_time must be ISO 8601");
  const droppedUrgent: Record<string, unknown> = { ...FIXTURE };
  delete droppedUrgent.urgent;
  assert.equal(summaryShapeError(droppedUrgent), "missing urgent");
  const droppedQuestions: Record<string, unknown> = { ...FIXTURE };
  delete droppedQuestions.questions;
  assert.equal(summaryShapeError(droppedQuestions), "missing questions");
  assert.equal(
    summaryShapeError({ ...FIXTURE, questions: [{ question: "Hi?", answered: true, extra: 1 }] } as unknown),
    "unexpected question field",
  );
  assert.equal(summaryShapeError({ ...FIXTURE, urgent: true, flags: [] }), "urgent flag missing");
  assert.equal(
    summaryShapeError({ ...FIXTURE, urgent: true, flags: ["possible_scam", "urgent"] }),
    "possible_scam overrides urgent",
  );
  assert.equal(summaryShapeError({ ...FIXTURE, urgent: true, flags: ["urgent"] }), null);
  const overridden = JSON.parse(
    serializeSummary({ ...FIXTURE, urgent: true, flags: ["possible_scam", "urgent"] }),
  ) as CallSummary;
  assert.equal(overridden.urgent, false);
  assert.deepEqual(overridden.flags, ["possible_scam"]);
  const fromLog = summaryFromLog(sampleEntry());
  assert.equal(fromLog.name, "Jane");
  assert.equal(fromLog.urgent, false);
  assert.equal(summaryShapeError(JSON.parse(serializeSummary(fromLog)) as unknown), null);
  const urgentLog = summaryFromLog(sampleEntry({ flags: ["urgent"] }));
  assert.equal(urgentLog.urgent, true);
  assert.deepEqual(urgentLog.flags, ["urgent"]);
  const scamLog = summaryFromLog(sampleEntry({ flags: ["money_related", "possible_scam", "urgent"] }));
  assert.equal(scamLog.urgent, false);
  assert.deepEqual(scamLog.flags, ["money_related", "possible_scam"]);
});

test("HMAC covers the timestamp and the raw body", () => {
  const body = serializeSummary(FIXTURE);
  assert.equal(signSummary("test-secret", "1700000000", body), EXPECTED_SIG);
  assert.notEqual(signSummary("test-secret", "1700000001", body), EXPECTED_SIG);
  assert.notEqual(signSummary("test-secret", "1700000000", `${body} `), EXPECTED_SIG);
  const header = `sha256=${EXPECTED_SIG}`;
  assert.equal(
    verifySummary({
      secret: "test-secret",
      timestamp: "1700000000",
      rawBody: body,
      signatureHeader: header,
      nowSec: 1700000100,
    }),
    true,
  );
  assert.equal(
    verifySummary({
      secret: "test-secret",
      timestamp: "1700000000",
      rawBody: body,
      signatureHeader: header,
      nowSec: 1700000000 + 301,
    }),
    false,
  );
  assert.equal(
    verifySummary({
      secret: "test-secret",
      timestamp: "1700000000",
      rawBody: body,
      signatureHeader: `sha256=${"ab".repeat(32)}`,
      nowSec: 1700000000,
    }),
    false,
  );
});

const PUBLIC_HOST = async (): Promise<string[]> => ["203.0.113.10"];

test("summary delivery signs the raw body, retries, and skips when unset", async () => {
  const skipped = await deliverSummary({
    url: undefined,
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 3,
    retryBaseMs: 0,
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.deepEqual(skipped, { status: "skipped", attempts: 0 });

  let hits = 0;
  let seenBody = "";
  let seenSig = "";
  let seenX = "";
  let seenTs = "";
  let seenRedirect = "";
  const result = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 1000,
    maxAttempts: 3,
    retryBaseMs: 0,
    nowMs: () => 1_700_000_000_000,
    resolveHost: PUBLIC_HOST,
    fetchImpl: async (_url, init) => {
      hits += 1;
      seenBody = String(init?.body ?? "");
      const headers = init?.headers as Record<string, string>;
      seenSig = headers["X-Summary-Signature"] ?? "";
      seenX = headers["X-Signature"] ?? "";
      seenTs = headers["X-Summary-Timestamp"] ?? "";
      seenRedirect = init?.redirect ?? "";
      assert.equal(headers.Authorization, undefined);
      if (hits < 3) return new Response("no", { status: 500 });
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(result.status, "delivered");
  assert.equal(result.attempts, 3);
  assert.equal(seenTs, "1700000000");
  assert.equal(seenBody, serializeSummary(FIXTURE));
  assert.equal(seenBody.includes('"urgent":false'), true);
  assert.equal(seenSig, `sha256=${signSummary("test-secret", seenTs, seenBody)}`);
  assert.equal(seenX, seenSig);
  assert.equal(seenRedirect, "error");
});

test("summary delivery allows https only and does not follow redirects", async () => {
  let hits = 0;
  let lookups = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    hits += 1;
    assert.equal(init?.redirect, "error");
    return new Response("ok", { status: 200 });
  };
  const skipped = await deliverSummary({
    url: "http://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 3,
    retryBaseMs: 0,
    resolveHost: async () => {
      lookups += 1;
      return ["203.0.113.10"];
    },
    fetchImpl,
  });
  assert.deepEqual(skipped, { status: "skipped", attempts: 0 });
  assert.equal(hits, 0);
  assert.equal(lookups, 0);

  const delivered = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    resolveHost: PUBLIC_HOST,
    fetchImpl,
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(hits, 1);
});

test("summary delivery does not retry a 400", async () => {
  let hits = 0;
  const fetchImpl: typeof fetch = async () => {
    hits += 1;
    return new Response("bad", { status: 400 });
  };
  const result = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 3,
    retryBaseMs: 0,
    resolveHost: PUBLIC_HOST,
    fetchImpl,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 1);
  assert.equal(hits, 1);
});

test("summary delivery backs off between attempts and does not log the secret", async () => {
  const secret = "super-secret-value";
  const delays: number[] = [];
  let hits = 0;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    const result = await deliverSummary({
      url: "https://desk.example/summary",
      secret,
      resolveHost: PUBLIC_HOST,
      summary: {
        ...FIXTURE,
        reason: "card 4111-1111-1111-1111",
        urgent: true,
        flags: ["urgent"],
      },
      timeoutMs: 200,
      maxAttempts: 3,
      retryBaseMs: 25,
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: async (_url, init) => {
        hits += 1;
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["X-Signature"], headers["X-Summary-Signature"]);
        const body = String(init?.body);
        assert.equal(body.includes("4111"), false);
        assert.equal(body.includes("[redacted]"), true);
        assert.equal(body.includes('"urgent":true'), true);
        assert.equal(body.includes(secret), false);
        if (hits < 3) return new Response("no", { status: 503 });
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(result.status, "delivered");
    assert.equal(result.attempts, 3);
    assert.deepEqual(delays, [25, 50]);
    assert.equal(warnings.some((line) => line.includes(secret)), false);
  } finally {
    console.warn = original;
  }
});

test("summary delivery refuses non-public addresses before connecting", async () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "169.254.169.254",
    "100.64.0.0",
    "100.127.255.255",
    "0.0.0.0",
    "0.255.255.255",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "febf::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:100.64.1.1",
    "::ffff:0.0.0.0",
    "fe80::1%eth0",
    "64:ff9b::",
    "64:ff9b::1",
    "64:ff9b::ffff:ffff",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::c0a8:1",
    "64:ff9b::192.0.2.1",
    "64:ff9b::127.0.0.1",
    "64:FF9B::1",
    "64:ff9b::1%eth0",
    "64:ff9b:1::",
    "64:ff9b:1::1",
    "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
    "64:ff9b:1::192.168.1.1",
    "2002::",
    "2002::1",
    "2002:7f00:1::",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "2002:c000:201::1",
    "2002:c0a8:1::1",
    "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2002::192.0.2.1",
  ];
  for (const address of blocked) {
    let hits = 0;
    const result = await deliverSummary({
      url: "https://desk.example/summary",
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 3,
      retryBaseMs: 0,
      resolveHost: async () => [address],
      fetchImpl: async () => {
        hits += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.deepEqual(result, { status: "skipped", attempts: 0 }, address);
    assert.equal(hits, 0, address);
  }

  let mixedHits = 0;
  const mixed = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    resolveHost: async () => ["203.0.113.10", "10.1.2.3"],
    fetchImpl: async () => {
      mixedHits += 1;
      return new Response("ok", { status: 200 });
    },
  });
  assert.deepEqual(mixed, { status: "skipped", attempts: 0 });
  assert.equal(mixedHits, 0);

  for (const address of ["64:ff9b::1", "64:ff9b:1::1", "2002:7f00:1::"]) {
    let hits = 0;
    const result = await deliverSummary({
      url: "https://desk.example/summary",
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      resolveHost: async () => ["203.0.113.10", address],
      fetchImpl: async () => {
        hits += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.deepEqual(result, { status: "skipped", attempts: 0 }, address);
    assert.equal(hits, 0, address);
  }

  const empty = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    resolveHost: async () => [],
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.deepEqual(empty, { status: "skipped", attempts: 0 });

  const failedLookup = await deliverSummary({
    url: "https://desk.example/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    resolveHost: async () => {
      throw new Error("dns");
    },
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.deepEqual(failedLookup, { status: "skipped", attempts: 0 });

  const allowed = [
    "203.0.113.10",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.0",
    "2001:db8::1",
    "::ffff:203.0.113.10",
    "64:ff9b:2::1",
    "64:ff9c::1",
    "64:ff9a::1",
    "2001:ffff::1",
    "2003::1",
  ];
  for (const address of allowed) {
    let hits = 0;
    const result = await deliverSummary({
      url: "https://desk.example/summary",
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      resolveHost: async () => [address],
      fetchImpl: async (_url, init) => {
        hits += 1;
        assert.equal(init?.redirect, "error");
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(result.status, "delivered", address);
    assert.equal(hits, 1, address);
  }

  const literals = [
    "https://127.0.0.1/summary",
    "https://10.1.2.3/summary",
    "https://192.168.0.1/summary",
    "https://169.254.169.254/summary",
    "https://100.64.1.1/summary",
    "https://0.0.0.0/summary",
    "https://[::1]/summary",
    "https://[::]/summary",
    "https://[fe80::1]/summary",
    "https://[fc00::1]/summary",
    "https://[fd00::1]/summary",
    "https://[::ffff:7f00:1]/summary",
    "https://[::ffff:127.0.0.1]/summary",
    "https://[64:ff9b::1]/summary",
    "https://[64:ff9b::7f00:1]/summary",
    "https://[64:ff9b::192.0.2.1]/summary",
    "https://[64:ff9b:1::1]/summary",
    "https://[2002::1]/summary",
    "https://[2002:7f00:1::]/summary",
    "https://[2002:c0a8:1::1]/summary",
  ];
  for (const url of literals) {
    let hits = 0;
    const result = await deliverSummary({
      url,
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      fetchImpl: async () => {
        hits += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.deepEqual(result, { status: "skipped", attempts: 0 }, url);
    assert.equal(hits, 0, url);
  }

  let publicHits = 0;
  const publicLiteral = await deliverSummary({
    url: "https://203.0.113.10/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    fetchImpl: async (_url, init) => {
      publicHits += 1;
      assert.equal(init?.redirect, "error");
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(publicLiteral.status, "delivered");
  assert.equal(publicHits, 1);

  let v6Hits = 0;
  const publicV6 = await deliverSummary({
    url: "https://[2001:db8::1]/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    fetchImpl: async () => {
      v6Hits += 1;
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(publicV6.status, "delivered");
  assert.equal(v6Hits, 1);

  const localhost = await deliverSummary({
    url: "https://localhost/summary",
    secret: "test-secret",
    summary: FIXTURE,
    timeoutMs: 200,
    maxAttempts: 1,
    retryBaseMs: 0,
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });
  assert.deepEqual(localhost, { status: "skipped", attempts: 0 });
});

test("summary delivery does not open a socket to loopback", async () => {
  let sockets = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  server.on("connection", () => {
    sockets += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  try {
    const cleartext = await deliverSummary({
      url: `http://127.0.0.1:${addr.port}/summary`,
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 500,
      maxAttempts: 1,
      retryBaseMs: 0,
    });
    const secure = await deliverSummary({
      url: `https://127.0.0.1:${addr.port}/summary`,
      secret: "test-secret",
      summary: FIXTURE,
      timeoutMs: 500,
      maxAttempts: 1,
      retryBaseMs: 0,
    });
    assert.deepEqual(cleartext, { status: "skipped", attempts: 0 });
    assert.deepEqual(secure, { status: "skipped", attempts: 0 });
    assert.equal(sockets, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

const PINNED_NAME = "pinned.example";
const PINNED_ADDRESS = PIN_ADDRESS;

interface RecordedRequest {
  path: string;
  host: string;
  sni: string;
  remote: string;
  signature: string;
  summarySignature: string;
  authorization: string;
  body: string;
}

interface WebhookFixture {
  port: number;
  ca: Buffer;
  requests: RecordedRequest[];
  trapHits: () => number;
  setStatus: (status: number) => void;
  close: () => Promise<void>;
}

function listen(server: net.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function serverPort(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  return addr.port;
}

/** Local HTTPS peer on a public documentation address, plus a loopback trap on the same port. */
async function startWebhookFixture(): Promise<WebhookFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "summary-webhook-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-nodes",
      "-subj",
      `/CN=${PINNED_NAME}`,
      "-addext",
      `subjectAltName=DNS:${PINNED_NAME}`,
    ],
    { stdio: "ignore" },
  );
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  const requests: RecordedRequest[] = [];
  let statusCode = 200;
  const sockets = new Set<net.Socket>();
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const socket = req.socket as tls.TLSSocket;
      requests.push({
        path: req.url ?? "",
        host: req.headers.host ?? "",
        sni: typeof socket.servername === "string" ? socket.servername : "",
        remote: socket.remoteAddress ?? "",
        signature: req.headers["x-signature"]?.toString() ?? "",
        summarySignature: req.headers["x-summary-signature"]?.toString() ?? "",
        authorization: req.headers.authorization?.toString() ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const headers: Record<string, string> = {};
      if (statusCode >= 300 && statusCode < 400) {
        headers.location = `https://127.0.0.1:${serverPort(server)}/stolen`;
      }
      res.writeHead(statusCode, headers);
      res.end("ok");
    });
  });
  server.on("connection", (socket) => {
    const tcp = socket as net.Socket;
    sockets.add(tcp);
    tcp.on("close", () => sockets.delete(tcp));
  });
  let trapHits = 0;
  const trapSockets = new Set<net.Socket>();
  const trap = net.createServer((socket) => {
    trapHits += 1;
    trapSockets.add(socket);
    socket.on("close", () => trapSockets.delete(socket));
    socket.destroy();
  });
  await listen(server, 0, PINNED_ADDRESS);
  const port = serverPort(server);
  await listen(trap, port, "127.0.0.1");
  return {
    port,
    ca: cert,
    requests,
    trapHits: () => trapHits,
    setStatus: (status: number) => {
      statusCode = status;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      for (const socket of trapSockets) socket.destroy();
      await closeServer(server);
      await closeServer(trap);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function recordLookupAddress(address: unknown, pinnedTo: string[]): void {
  if (typeof address === "string") {
    pinnedTo.push(address);
    return;
  }
  if (!Array.isArray(address)) return;
  for (const item of address) {
    if (item && typeof item === "object" && "address" in item && typeof item.address === "string") {
      pinnedTo.push(item.address);
    }
  }
}

/**
 * While installed, dns.lookup answers 127.0.0.1 and the first dns.promises.lookup of
 * pinned.example answers the vetted address. Socket lookups are recorded.
 */
function installRebindingProbe(pinnedTo: string[]): () => void {
  const originalLookup = dns.lookup;
  const originalResolve = dns.promises.lookup;
  const originalConnect = net.Socket.prototype.connect;
  let promiseCalls = 0;
  dns.promises.lookup = (async (hostname: string, options?: unknown) => {
    if (hostname !== PINNED_NAME) return originalResolve(hostname, options as never);
    promiseCalls += 1;
    const address = promiseCalls === 1 ? PINNED_ADDRESS : "127.0.0.1";
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      (options as { all?: boolean }).all === true;
    if (all) return [{ address, family: 4 }];
    return { address, family: 4 };
  }) as typeof dns.promises.lookup;
  dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    if (hostname !== PINNED_NAME) {
      return originalLookup(hostname as never, options as never, callback as never);
    }
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
    else cb(null, "127.0.0.1", 4);
  }) as typeof dns.lookup;
  net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
    const first = args[0];
    if (first && typeof first === "object" && "lookup" in first) {
      const options = first as { lookup?: LookupFunction };
      const inner = options.lookup;
      if (inner) {
        options.lookup = (hostname, lookupOptions, cb) => {
          inner(hostname, lookupOptions, (err, address, family) => {
            recordLookupAddress(address, pinnedTo);
            cb(err, address, family);
          });
        };
      }
    }
    return originalConnect.apply(this, args as never);
  } as typeof net.Socket.prototype.connect;
  return () => {
    dns.lookup = originalLookup;
    dns.promises.lookup = originalResolve;
    net.Socket.prototype.connect = originalConnect;
  };
}

test("summary delivery pins the vetted address so a second lookup cannot redirect the socket", async () => {
  const fixture = await startWebhookFixture();
  const pinnedTo: string[] = [];
  const restore = installRebindingProbe(pinnedTo);
  const secret = "test-secret";
  try {
    const result = await deliverSummary({
      url: `https://${PINNED_NAME}:${fixture.port}/summary?x=1`,
      secret,
      summary: FIXTURE,
      timeoutMs: 2000,
      maxAttempts: 1,
      retryBaseMs: 0,
      nowMs: () => 1_700_000_000_000,
      ca: fixture.ca,
    });
    assert.equal(result.status, "delivered");
    assert.equal(result.attempts, 1);
    assert.equal(fixture.trapHits(), 0);
    assert.equal(fixture.requests.length, 1);
    const posted = fixture.requests[0];
    if (!posted) throw new Error("missing request");
    assert.equal(posted.path, "/summary?x=1");
    assert.equal(posted.host, `${PINNED_NAME}:${fixture.port}`);
    assert.equal(posted.sni, PINNED_NAME);
    assert.equal(posted.remote, PINNED_ADDRESS);
    assert.equal(posted.body, serializeSummary(FIXTURE));
    const expected = `sha256=${signSummary(secret, "1700000000", posted.body)}`;
    assert.equal(posted.signature, expected);
    assert.equal(posted.summarySignature, expected);
    assert.equal(posted.authorization, "");
    assert.equal(pinnedTo.length > 0, true);
    assert.equal(pinnedTo.every((address) => address === PINNED_ADDRESS), true);
    const rebound = await new Promise<string>((resolve, reject) => {
      dns.lookup(PINNED_NAME, { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses[0]?.address ?? "");
      });
    });
    assert.equal(rebound, "127.0.0.1");
    assert.equal(fixture.trapHits(), 0);

    pinnedTo.length = 0;
    const both = await deliverSummary({
      url: `https://${PINNED_NAME}:${fixture.port}/summary`,
      secret,
      summary: FIXTURE,
      timeoutMs: 2000,
      maxAttempts: 1,
      retryBaseMs: 0,
      ca: fixture.ca,
      resolveHost: async () => [PINNED_ADDRESS, "198.51.100.20"],
    });
    assert.equal(both.status, "delivered");
    assert.equal(pinnedTo.length > 0, true);
    assert.deepEqual([...new Set(pinnedTo)], [PINNED_ADDRESS]);
    assert.equal(fixture.trapHits(), 0);

    const before = fixture.requests.length;
    const mismatch = await deliverSummary({
      url: `https://wrong.example:${fixture.port}/summary`,
      secret,
      summary: FIXTURE,
      timeoutMs: 2000,
      maxAttempts: 1,
      retryBaseMs: 0,
      ca: fixture.ca,
      resolveHost: async () => [PINNED_ADDRESS],
    });
    assert.equal(mismatch.status, "failed");
    assert.equal(mismatch.attempts, 1);
    assert.equal(fixture.requests.length, before);
    assert.equal(fixture.trapHits(), 0);
  } finally {
    restore();
    await fixture.close();
  }
});

test("summary delivery does not follow a 3xx and re-checks the host on retry", async () => {
  const fixture = await startWebhookFixture();
  const secret = "test-secret";
  try {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      fixture.setStatus(status);
      const before = fixture.requests.length;
      const trapBefore = fixture.trapHits();
      const result = await deliverSummary({
        url: `https://${PINNED_NAME}:${fixture.port}/summary`,
        secret,
        summary: FIXTURE,
        timeoutMs: 2000,
        maxAttempts: 3,
        retryBaseMs: 0,
        ca: fixture.ca,
        resolveHost: async () => [PINNED_ADDRESS],
      });
      assert.deepEqual(result, { status: "failed", attempts: 1 }, String(status));
      assert.equal(fixture.requests.length, before + 1, String(status));
      assert.equal(fixture.requests[fixture.requests.length - 1]?.path, "/summary", String(status));
      assert.equal(fixture.trapHits(), trapBefore, String(status));
    }

    fixture.setStatus(500);
    const beforeRetry = fixture.requests.length;
    let resolves = 0;
    const retried = await deliverSummary({
      url: `https://${PINNED_NAME}:${fixture.port}/summary`,
      secret,
      summary: FIXTURE,
      timeoutMs: 2000,
      maxAttempts: 3,
      retryBaseMs: 0,
      ca: fixture.ca,
      resolveHost: async () => {
        resolves += 1;
        return resolves === 1 ? [PINNED_ADDRESS] : ["127.0.0.1"];
      },
    });
    assert.equal(resolves, 2);
    assert.deepEqual(retried, { status: "failed", attempts: 1 });
    assert.equal(fixture.requests.length, beforeRetry + 1);
    assert.equal(fixture.trapHits(), 0);

    fixture.setStatus(200);
    const authOnlyBefore = fixture.requests.length;
    const authOnly = await deliverSummary({
      url: `https://${PINNED_NAME}:${fixture.port}/hook`,
      secret: undefined,
      auth: "desk-token-value",
      summary: { ...FIXTURE, flags: ["auto_summary"], urgent: false },
      timeoutMs: 2000,
      maxAttempts: 1,
      retryBaseMs: 0,
      ca: fixture.ca,
      resolveHost: async () => [PINNED_ADDRESS],
    });
    assert.equal(authOnly.status, "delivered");
    assert.equal(fixture.requests.length, authOnlyBefore + 1);
    const authed = fixture.requests[fixture.requests.length - 1];
    if (!authed) throw new Error("missing auth request");
    assert.equal(authed.path, "/hook");
    assert.equal(authed.authorization, "Bearer desk-token-value");
    assert.equal(authed.signature, "");
    assert.equal(authed.summarySignature, "");
    assert.equal(authed.body.includes('"urgent":false'), true);
    assert.equal(authed.body.includes("auto_summary"), true);
    assert.equal(authed.body.includes("desk-token-value"), false);
    assert.equal(fixture.trapHits(), 0);
  } finally {
    await fixture.close();
  }
});

test("SUMMARY_WEBHOOK_AUTH is optional and a control character is rejected at config load", () => {
  assert.equal(loadConfig({ NODE_ENV: "test" }).summaryWebhookAuth, undefined);
  assert.equal(loadConfig({ SUMMARY_WEBHOOK_AUTH: "" }).summaryWebhookAuth, undefined);
  assert.equal(loadConfig({ SUMMARY_WEBHOOK_AUTH: "   " }).summaryWebhookAuth, undefined);
  assert.equal(loadConfig({ SUMMARY_WEBHOOK_AUTH: "  desk-token  " }).summaryWebhookAuth, "desk-token");
  assert.equal(
    loadConfig({ SUMMARY_WEBHOOK_AUTH: "  Bearer desk-token  " }).summaryWebhookAuth,
    "Bearer desk-token",
  );

  const secret = "desk-token-SECRET";
  const bad = [
    `${secret}\n`,
    `${secret}\r`,
    `${secret}\r\nX-Injected: 1`,
    `Bearer ${secret}\n`,
    `${secret}\u0000tail`,
    `${secret}\u0009tail`,
    `${secret}\u007F`,
    `${secret}\u0085`,
    `\n${secret}`,
    `${secret.slice(0, 4)}\u000B${secret.slice(4)}`,
  ];
  for (const value of bad) {
    assert.throws(
      () => loadConfig({ SUMMARY_WEBHOOK_AUTH: value }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "SUMMARY_WEBHOOK_AUTH contains a control character");
        assert.equal(err.message.includes(secret), false);
        assert.equal(String(err).includes(secret), false);
        return true;
      },
      JSON.stringify(value),
    );
  }
});

test("summary delivery sends Authorization, signs only when a secret is set, and does not log the auth value", async () => {
  const auth = "super-auth-value";
  assert.equal(summaryAuthorizationValue(auth), `Bearer ${auth}`);
  assert.equal(summaryAuthorizationValue("Bearer already"), "Bearer already");
  assert.equal(summaryAuthorizationValue("bearer already"), "bearer already");
  assert.equal(summaryAuthorizationValue("Basic dXNlcjpwYXNz"), "Basic dXNlcjpwYXNz");
  assert.equal(summaryAuthorizationValue("Bearer"), "Bearer Bearer");

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    let hits = 0;
    const skipped = await deliverSummary({
      url: "https://desk.example/summary",
      secret: undefined,
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 2,
      retryBaseMs: 0,
      resolveHost: PUBLIC_HOST,
      fetchImpl: async () => {
        hits += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.deepEqual(skipped, { status: "skipped", attempts: 0 });
    assert.equal(hits, 0);

    const httpSkipped = await deliverSummary({
      url: "http://desk.example/summary",
      secret: undefined,
      auth,
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      resolveHost: PUBLIC_HOST,
      fetchImpl: async () => {
        hits += 1;
        return new Response("ok", { status: 200 });
      },
    });
    assert.deepEqual(httpSkipped, { status: "skipped", attempts: 0 });
    assert.equal(hits, 0);

    let seenAuth = "";
    let attempts = 0;
    const delivered = await deliverSummary({
      url: "https://desk.example/summary",
      secret: undefined,
      auth,
      summary: { ...FIXTURE, flags: ["auto_summary"], urgent: false, name: null, reason: null },
      timeoutMs: 200,
      maxAttempts: 3,
      retryBaseMs: 10,
      sleep: async () => undefined,
      resolveHost: PUBLIC_HOST,
      fetchImpl: async (_url, init) => {
        attempts += 1;
        const headers = init?.headers as Record<string, string>;
        seenAuth = headers.Authorization ?? "";
        assert.equal(headers["X-Signature"], undefined);
        assert.equal(headers["X-Summary-Signature"], undefined);
        assert.equal(headers["X-Summary-Timestamp"], undefined);
        assert.equal(init?.redirect, "error");
        const body = String(init?.body);
        assert.equal(body.includes('"urgent":false'), true);
        assert.equal(body.includes("auto_summary"), true);
        assert.equal(body.includes(auth), false);
        if (attempts < 2) return new Response("no", { status: 503 });
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attempts, 2);
    assert.equal(seenAuth, `Bearer ${auth}`);

    let verbatim = "";
    const basic = await deliverSummary({
      url: "https://desk.example/summary",
      secret: undefined,
      auth: "Basic dXNlcjpwYXNz",
      summary: FIXTURE,
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      resolveHost: PUBLIC_HOST,
      fetchImpl: async (_url, init) => {
        verbatim = (init?.headers as Record<string, string>).Authorization ?? "";
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(basic.status, "delivered");
    assert.equal(verbatim, "Basic dXNlcjpwYXNz");

    let signedAuth = "";
    let signedX = "";
    const both = await deliverSummary({
      url: "https://desk.example/summary",
      secret: "test-secret",
      auth,
      summary: { ...FIXTURE, urgent: true, flags: ["urgent"] },
      timeoutMs: 200,
      maxAttempts: 1,
      retryBaseMs: 0,
      nowMs: () => 1_700_000_000_000,
      resolveHost: PUBLIC_HOST,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        signedAuth = headers.Authorization ?? "";
        signedX = headers["X-Signature"] ?? "";
        assert.equal(headers["X-Summary-Signature"], signedX);
        assert.equal(headers["X-Summary-Timestamp"], "1700000000");
        const body = String(init?.body);
        assert.equal(body.includes('"urgent":true'), true);
        assert.equal(signedX, `sha256=${signSummary("test-secret", "1700000000", body)}`);
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(both.status, "delivered");
    assert.equal(signedAuth, `Bearer ${auth}`);
    assert.equal(signedX.startsWith("sha256="), true);
    assert.equal(warnings.some((line) => line.includes(auth) || line.includes("dXNlcjpwYXNz")), false);
  } finally {
    console.warn = original;
  }
});
