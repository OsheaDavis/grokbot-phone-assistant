import http from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import {
  APPROVED_FACTS_MAX_BYTES,
  deleteApprovedFacts,
  parseApprovedFactsBody,
  readApprovedFacts,
  writeApprovedFacts,
} from "../approved-facts.js";
import type { AppConfig } from "../config.js";
import { loadCallerLists } from "../callers.js";
import { attachBridge, type AttachInput } from "../bridge/attach.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { maskPhone } from "../phone.js";
import { RateLimiter } from "../rate-limit.js";
import { deliverSummary } from "../summary/deliver.js";
import {
  KNOWN_PEOPLE_MAX_BYTES,
  deleteKnownPeople,
  parseKnownPeopleBody,
  readKnownPeople,
  writeKnownPeople,
} from "../known-people.js";
import { summaryFromLog } from "../summary/payload.js";
import { buildDirectCallLog, buildStatusCallLog, isTerminalCallStatus, type CallStore } from "../store/calls.js";
import { bearerMatches } from "../auth.js";
import { ApprovalStore } from "../outbound/approval.js";
import type { RefuseOnlyAiCheck } from "../outbound/ai-check.js";
import type { OutboundTwilioClient } from "../outbound/dialer.js";
import { OUTBOUND_STATUS_PATH, handleOutbound, handleOutboundStatus, isOutboundPath, outboundRoutesLive } from "../outbound/routes.js";
import { CardStore } from "../outbound/card.js";
import type { ReplyLabeler } from "../outbound/classify.js";
import { outboundBearer } from "../outbound/enabled.js";
import { appendOutcome, outboundSummary, writeLessons, type LoggedOutcome } from "../outbound/outcome-log.js";
import { OUTBOUND_TURN_PATH, OutcomeStore, runTurn } from "../outbound/turn.js";
import {
  LIFE_CONTEXT_MAX_BYTES,
  activeLifeContext,
  deleteLifeContext,
  parseLifeContextBody,
  readLifeContext,
  writeLifeContext,
} from "../life-context.js";
import type { CallLogEntry } from "../types.js";
import { classifyCaller, RepeatTracker, screenCaller } from "../twilio/policy.js";
import { publicOriginError, signatureDecision, signedWebhookUrl, validateTwilioSignature } from "../twilio/signature.js";
import {
  claimStreamGrant,
  isMediaStreamUpgrade,
  issueStreamCredentials,
  lookupStreamGrant,
  mediaStreamUrl,
  parseMediaStreamPath,
  rememberStreamGrant,
  verifyStreamToken,
} from "../twilio/stream-token.js";
import {
  BLOCK_MESSAGE,
  SPAM_MESSAGE,
  UNAVAILABLE_MESSAGE,
  connectStreamTwiml,
  hangupTwiml,
} from "../twilio/twiml.js";

const BLOCK_SUMMARY = "Blocklisted caller. The call was ended without taking a message.";
const SPAM_SUMMARY = "No caller ID or a repeat pattern. The call was ended without taking a message.";
const UNAVAILABLE_SUMMARY = "The assistant was unavailable. The call was ended without taking a message.";

export interface AppDeps {
  config: AppConfig;
  store: CallStore;
  repeatTracker?: RepeatTracker;
  voiceLimiter?: RateLimiter;
  messagesLimiter?: RateLimiter;
  bridge?: (input: AttachInput) => void;
  /** Test seam. Production uses deliverSummary. */
  postSummary?: typeof deliverSummary;
  /** Outbound stage 1. Routes 404 unless OUTBOUND_ENABLED and OUTBOUND_BEARER_TOKEN are set. */
  outboundEnv?: NodeJS.ProcessEnv;
  outboundStore?: ApprovalStore;
  outboundClient?: OutboundTwilioClient;
  outboundAiCheck?: RefuseOnlyAiCheck;
  outboundLimiter?: RateLimiter;
  /** Test seam for the per-call safety timeout. */
  outboundSchedule?: (fn: () => void, ms: number) => void;
  /** Stage 2 context cards. Default: <dataDir>/call-cards on the volume. */
  outboundCards?: CardStore;
  /** Optional enum-only reply labeler. Absent means rules only. */
  outboundLabeler?: ReplyLabeler;
  now?: () => number;
}

export interface App {
  server: http.Server;
  wss: WebSocketServer;
  drain: () => Promise<void>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isClientIp(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 3 && trimmed.length <= 64 && /^[0-9a-fA-F:.]+$/.test(trimmed);
}

function clientIp(req: http.IncomingMessage, production: boolean): string {
  const fly = headerValue(req.headers["fly-client-ip"]);
  // Fly's proxy sets Fly-Client-IP. X-Forwarded-For's left side is client-supplied.
  if (fly && isClientIp(fly)) return fly.trim();
  if (!production) {
    const forwarded = headerValue(req.headers["x-forwarded-for"]);
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

function pathnameOf(req: http.IncomingMessage): string {
  const raw = req.url ?? "/";
  const end = raw.indexOf("?");
  const path = end === -1 ? raw : raw.slice(0, end);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path || "/";
}

function readBody(req: http.IncomingMessage, limit = 65_536): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.pause();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
}

function sendXml(res: http.ServerResponse, xml: string): void {
  res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
  res.end(xml);
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403): void {
  const reason = http.STATUS_CODES[status] ?? "Error";
  const body = status === 403 ? "forbidden" : status === 400 ? "bad_request" : "unauthorized";
  socket.once("error", () => undefined);
  socket.once("finish", () => {
    socket.destroy();
  });
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        "\r\n" +
        body,
    );
  } catch {
    socket.destroy();
  }
}

function publicBase(config: AppConfig, req: http.IncomingMessage): string | null {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = headerValue(req.headers["x-forwarded-host"]) ?? headerValue(req.headers.host);
  if (!host) return null;
  const proto = headerValue(req.headers["x-forwarded-proto"]) ?? "https";
  return `${proto}://${host}`;
}

export function createApp(deps: AppDeps): App {
  const { config, store } = deps;
  const repeatTracker =
    deps.repeatTracker ?? new RepeatTracker(config.spamRepeatMax, config.spamRepeatWindowMs);
  const voiceLimiter = deps.voiceLimiter ?? new RateLimiter(config.rateLimitTwilioMax, config.rateLimitWindowMs);
  const messagesLimiter =
    deps.messagesLimiter ?? new RateLimiter(config.rateLimitMessagesMax, config.rateLimitWindowMs);
  const bridge = deps.bridge ?? attachBridge;
  const outboundStore = deps.outboundStore ?? new ApprovalStore();
  const outboundLimiter =
    deps.outboundLimiter ?? new RateLimiter(config.rateLimitMessagesMax, config.rateLimitWindowMs);
  const postSummary = deps.postSummary ?? deliverSummary;
  const outboundCards = deps.outboundCards ?? CardStore.forDataDir(config.dataDir);
  const outboundOutcomes = new OutcomeStore();
  const publicOrigin =
    config.publicBaseUrl && !publicOriginError(config.publicBaseUrl, config.production)
      ? config.publicBaseUrl.replace(/\/+$/, "")
      : undefined;
  const pending = new Set<Promise<unknown>>();
  const statusReported = new Set<string>();

  function track<T extends Promise<unknown>>(job: T): T {
    pending.add(job);
    void job.finally(() => {
      pending.delete(job);
    });
    return job;
  }

  async function drain(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
    }
  }

  function saveCall(entry: CallLogEntry): Promise<void> {
    const persist = (async () => {
      try {
        await store.append(entry);
        logInfo(
          `call saved sid=${entry.call_sid ?? "none"} from=${maskPhone(entry.caller_number)} disposition=${entry.disposition} flags=${entry.flags.join(",") || "none"}`,
        );
      } catch {
        logError("failed to persist call log");
      }
    })();
    track(persist);
    track(
      persist.then(() =>
        postSummary({
          url: config.summaryWebhookUrl,
          secret: config.summaryWebhookSecret,
          auth: config.summaryWebhookAuth,
          summary: summaryFromLog(entry),
          timeoutMs: config.summaryTimeoutMs,
          maxAttempts: config.summaryMaxAttempts,
          retryBaseMs: config.summaryRetryBaseMs,
        }).then(
          () => undefined,
          () => {
            logError("summary delivery threw");
          },
        ),
      ),
    );
    return persist;
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const name = err instanceof Error ? err.name : "Error";
      logError(`request failed name=${name}`);
      if (!res.headersSent) sendText(res, 500, "error");
    });
  });

  // `path: "/media-stream"` matches that pathname only. The grant is a longer path.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = req.url ?? "/";
    if (!isMediaStreamUpgrade(requestUrl)) {
      rejectUpgrade(socket, 400);
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const parsed = parseMediaStreamPath(requestUrl);
    if (!parsed) {
      logWarn("rejected media stream");
      rejectUpgrade(socket, 401);
      return;
    }
    const verified = verifyStreamToken({
      secret: config.twilioAuthToken,
      expRaw: parsed.expRaw,
      callSid: parsed.callSid,
      from: parsed.from,
      startedAtRaw: parsed.startedAtRaw,
      token: parsed.token,
      nowSec,
      production: config.production,
      allowInsecureDev: config.allowInsecureDevWebhook,
    });
    if (!verified.ok) {
      logWarn("rejected media stream");
      rejectUpgrade(socket, 401);
      return;
    }
    const lists = loadCallerLists(config.callersConfigPath);
    const screen = classifyCaller(verified.from, lists);
    if (screen.action !== "connect") {
      logWarn(`rejected media stream action=${screen.action} from=${maskPhone(screen.callerNumber)}`);
      rejectUpgrade(socket, 403);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!claimStreamGrant(verified.callSid, verified.exp, verified.startedAtMs, nowSec)) {
        logWarn("rejected replayed media stream");
        ws.close(1008, "unauthorized");
        return;
      }
      bridge({
        twilio: ws,
        config,
        callSid: verified.callSid,
        callerNumber: screen.callerNumber,
        flags: screen.flags,
        startedAtMs: verified.startedAtMs,
        onComplete: (entry) => {
          void saveCall(entry);
        },
      });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = pathnameOf(req);
    const ip = clientIp(req, config.production);

    if (path === "/health" && (req.method === "GET" || req.method === "HEAD")) {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end();
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/messages") {
      if (req.method !== "GET") {
        sendText(res, 405, "method_not_allowed");
        return;
      }
      if (!messagesLimiter.allow(ip)) {
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60", "cache-control": "no-store" });
        return;
      }
      if (!bearerMatches(headerValue(req.headers.authorization), config.messagesBearerToken)) {
        sendJson(res, 401, { error: "unauthorized" }, { "cache-control": "no-store" });
        return;
      }
      const url = new URL(req.url ?? "/messages", "http://localhost");
      const since = url.searchParams.get("since") ?? undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        sendJson(res, 400, { error: "invalid_since" }, { "cache-control": "no-store" });
        return;
      }
      const urgent = url.searchParams.get("urgent");
      if (urgent !== null && urgent !== "1") {
        sendJson(res, 400, { error: "invalid_urgent" }, { "cache-control": "no-store" });
        return;
      }
      const entries = await store.readSince(since);
      const messages = entries.map(summaryFromLog).filter((message) => (urgent === "1" ? message.urgent : true));
      sendJson(res, 200, { messages }, { "cache-control": "no-store" });
      return;
    }

    if (path === "/admin/life-context") {
      if (!messagesLimiter.allow(ip)) {
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60", "cache-control": "no-store" });
        return;
      }
      if (!bearerMatches(headerValue(req.headers.authorization), config.messagesBearerToken)) {
        sendJson(res, 401, { error: "unauthorized" }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "GET") {
        const read = readLifeContext(config.dataDir);
        if (!read.ok) {
          const status = read.reason === "absent" ? 404 : 500;
          const error = read.reason === "absent" ? "not_found" : "unreadable";
          sendJson(res, status, { error }, { "cache-control": "no-store" });
          return;
        }
        sendJson(res, 200, read.value, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "DELETE") {
        try {
          deleteLifeContext(config.dataDir);
        } catch {
          logError("failed to clear life context");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
          return;
        }
        logInfo("life context cleared");
        sendJson(res, 200, { ok: true }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "PUT") {
        let body = "";
        try {
          body = await readBody(req, LIFE_CONTEXT_MAX_BYTES);
        } catch {
          sendJson(res, 413, { error: "payload_too_large" }, { "cache-control": "no-store" });
          req.destroy();
          return;
        }
        const parsed = parseLifeContextBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: "invalid_life_context" }, { "cache-control": "no-store" });
          return;
        }
        try {
          const stored = writeLifeContext(config.dataDir, parsed.value);
          logInfo("life context updated");
          sendJson(res, 200, stored, { "cache-control": "no-store" });
        } catch {
          logError("failed to store life context");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
        }
        return;
      }
      sendText(res, 405, "method_not_allowed");
      return;
    }

    if (path === "/admin/known-people") {
      if (!messagesLimiter.allow(ip)) {
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60", "cache-control": "no-store" });
        return;
      }
      if (!bearerMatches(headerValue(req.headers.authorization), config.messagesBearerToken)) {
        sendJson(res, 401, { error: "unauthorized" }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "GET") {
        const read = readKnownPeople(config.dataDir);
        if (!read.ok) {
          const status = read.reason === "absent" ? 404 : 500;
          const error = read.reason === "absent" ? "not_found" : "unreadable";
          sendJson(res, status, { error }, { "cache-control": "no-store" });
          return;
        }
        sendJson(res, 200, read.value, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "DELETE") {
        try {
          deleteKnownPeople(config.dataDir);
        } catch {
          logError("failed to clear known people");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
          return;
        }
        logInfo("known people cleared");
        sendJson(res, 200, { ok: true }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "PUT") {
        let body = "";
        try {
          body = await readBody(req, KNOWN_PEOPLE_MAX_BYTES);
        } catch {
          sendJson(res, 413, { error: "payload_too_large" }, { "cache-control": "no-store" });
          req.destroy();
          return;
        }
        const parsed = parseKnownPeopleBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: "invalid_known_people" }, { "cache-control": "no-store" });
          return;
        }
        try {
          const stored = writeKnownPeople(config.dataDir, parsed.value);
          logInfo("known people updated");
          sendJson(res, 200, stored, { "cache-control": "no-store" });
        } catch {
          logError("failed to store known people");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
        }
        return;
      }
      sendText(res, 405, "method_not_allowed");
      return;
    }

    if (path === "/admin/approved-facts") {
      if (!messagesLimiter.allow(ip)) {
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60", "cache-control": "no-store" });
        return;
      }
      if (!bearerMatches(headerValue(req.headers.authorization), config.messagesBearerToken)) {
        sendJson(res, 401, { error: "unauthorized" }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "GET") {
        const read = readApprovedFacts(config.dataDir);
        if (!read.ok) {
          const status = read.reason === "absent" ? 404 : 500;
          const error = read.reason === "absent" ? "not_found" : "unreadable";
          sendJson(res, status, { error }, { "cache-control": "no-store" });
          return;
        }
        sendJson(res, 200, read.value, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "DELETE") {
        try {
          deleteApprovedFacts(config.dataDir);
        } catch {
          logError("failed to clear approved facts");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
          return;
        }
        logInfo("approved facts cleared");
        sendJson(res, 200, { ok: true }, { "cache-control": "no-store" });
        return;
      }
      if (req.method === "PUT") {
        let body = "";
        try {
          body = await readBody(req, APPROVED_FACTS_MAX_BYTES);
        } catch {
          sendJson(res, 413, { error: "payload_too_large" }, { "cache-control": "no-store" });
          req.destroy();
          return;
        }
        const parsed = parseApprovedFactsBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: "invalid_approved_facts" }, { "cache-control": "no-store" });
          return;
        }
        try {
          const stored = writeApprovedFacts(config.dataDir, parsed.value);
          logInfo("approved facts updated");
          sendJson(res, 200, stored, { "cache-control": "no-store" });
        } catch {
          logError("failed to store approved facts");
          sendJson(res, 500, { error: "unavailable" }, { "cache-control": "no-store" });
        }
        return;
      }
      sendText(res, 405, "method_not_allowed");
      return;
    }

    if (path === "/status") {
      if (req.method !== "POST") {
        sendText(res, 405, "method_not_allowed");
        return;
      }
      if (!voiceLimiter.allow(ip)) {
        sendText(res, 429, "rate_limited", { "retry-after": "60" });
        return;
      }
      const statusOriginError = publicOriginError(config.publicBaseUrl, config.production);
      if (statusOriginError && statusOriginError !== "insecure") {
        logWarn(`rejected twilio status callback origin=${statusOriginError}`);
        sendText(res, 403, "forbidden");
        return;
      }
      let statusBody = "";
      try {
        statusBody = await readBody(req);
      } catch {
        sendText(res, 413, "payload_too_large");
        req.destroy();
        return;
      }
      const statusParams = parseForm(statusBody);
      const statusUrl = signedWebhookUrl(config.publicBaseUrl, req);
      const statusDecision = statusUrl
        ? signatureDecision({
            production: config.production,
            authToken: config.twilioAuthToken,
            allowInsecureDev: config.allowInsecureDevWebhook,
            signature: headerValue(req.headers["x-twilio-signature"]),
            url: statusUrl,
            params: statusParams,
          })
        : "rejected";
      if (statusDecision !== "ok") {
        logWarn("rejected twilio status callback");
        sendText(res, 403, "forbidden");
        return;
      }
      const statusSid = statusParams.CallSid ?? "";
      const callStatus = statusParams.CallStatus;
      sendText(res, 204, "");
      if (!/^[A-Za-z0-9]{1,64}$/.test(statusSid) || !isTerminalCallStatus(callStatus)) return;
      if (statusReported.has(statusSid)) return;
      statusReported.add(statusSid);
      if (statusReported.size > 5000) statusReported.delete(statusReported.values().next().value as string);
      const durationRaw = Number.parseInt(statusParams.CallDuration ?? "0", 10);
      const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(durationRaw, 86_400) : 0;
      const statusFrom = statusParams.From ?? null;
      const receivedMs = Date.now();
      track(
        (async () => {
          if (config.statusGraceMs > 0) await new Promise((r) => setTimeout(r, config.statusGraceMs));
          try {
            if (await store.hasCallSid(statusSid)) return;
          } catch {
            logError("status callback could not read the call log");
          }
          logInfo(`status-only call sid=${statusSid} status=${callStatus ?? "unknown"}`);
          await saveCall(
            buildStatusCallLog({
              callSid: statusSid,
              callerNumber: statusFrom,
              status: callStatus ?? "unknown",
              durationSec,
              nowMs: receivedMs,
            }),
          );
        })(),
      );
      return;
    }

    if (path === "/voice") {
      if (req.method !== "POST") {
        sendText(res, 405, "method_not_allowed");
        return;
      }
      if (!voiceLimiter.allow(ip)) {
        sendText(res, 429, "rate_limited", { "retry-after": "60" });
        return;
      }
      const originError = publicOriginError(config.publicBaseUrl, config.production);
      if (originError && originError !== "insecure") {
        logWarn(`rejected twilio voice webhook origin=${originError}`);
        sendText(res, 403, "forbidden");
        return;
      }
      let body = "";
      try {
        body = await readBody(req);
      } catch {
        sendText(res, 413, "payload_too_large");
        req.destroy();
        return;
      }
      const params = parseForm(body);
      const signedUrl = signedWebhookUrl(config.publicBaseUrl, req);
      if (!signedUrl) {
        logWarn("rejected twilio voice webhook; signed url could not be built");
        sendText(res, 403, "forbidden");
        return;
      }
      const decision = signatureDecision({
        production: config.production,
        authToken: config.twilioAuthToken,
        allowInsecureDev: config.allowInsecureDevWebhook,
        signature: headerValue(req.headers["x-twilio-signature"]),
        url: signedUrl,
        params,
      });
      if (decision !== "ok") {
        logWarn("rejected twilio voice webhook");
        sendText(res, 403, "forbidden");
        return;
      }

      const from = params.From ?? "";
      const callSid = params.CallSid ?? "";
      const nowMs = Date.now();
      const lists = loadCallerLists(config.callersConfigPath);
      const screen = screenCaller(from, lists, repeatTracker, nowMs);

      const direct = async (
        disposition: "blocked" | "spam" | "unavailable",
        summary: string,
        message: string,
      ): Promise<void> => {
        const life = activeLifeContext(config.dataDir, new Date(nowMs));
        const flags = life ? [...screen.flags, "life_context_active"] : screen.flags;
        const entry = buildDirectCallLog({
          callSid: /^[A-Za-z0-9]{1,64}$/.test(callSid) ? callSid : null,
          callerNumber: screen.callerNumber,
          flags,
          disposition,
          summary,
          nowMs,
        });
        await saveCall(entry);
        sendXml(res, hangupTwiml(message));
      };

      if (screen.action === "block") {
        await direct("blocked", BLOCK_SUMMARY, BLOCK_MESSAGE);
        return;
      }
      if (screen.action === "spam") {
        await direct("spam", SPAM_SUMMARY, SPAM_MESSAGE);
        return;
      }
      if (!/^[A-Za-z0-9]{1,64}$/.test(callSid) || !config.xaiApiKey || originError === "insecure") {
        await direct("unavailable", UNAVAILABLE_SUMMARY, UNAVAILABLE_MESSAGE);
        return;
      }
      const base = publicBase(config, req);
      const nowSec = Math.floor(nowMs / 1000);
      const cached = lookupStreamGrant(callSid, nowSec);
      let grant = cached && cached.from === from ? cached : null;
      if (!grant && base) {
        const issued = issueStreamCredentials({
          secret: config.twilioAuthToken,
          callSid,
          from,
          startedAtMs: nowMs,
          nowSec,
          production: config.production,
          allowInsecureDev: config.allowInsecureDevWebhook,
        });
        if (issued) {
          grant = { exp: issued.exp, token: issued.token, from, startedAtMs: nowMs };
          rememberStreamGrant(callSid, grant, nowSec);
        }
      }
      if (!base || !grant) {
        await direct("unavailable", UNAVAILABLE_SUMMARY, UNAVAILABLE_MESSAGE);
        return;
      }
      const streamUrl = mediaStreamUrl(base, {
        exp: String(grant.exp),
        callSid,
        from: grant.from,
        t: String(grant.startedAtMs),
        token: grant.token,
      });
      sendXml(res, connectStreamTwiml(streamUrl));
      return;
    }

    if (isOutboundPath(path)) {
      const env = deps.outboundEnv ?? process.env;
      if (path === OUTBOUND_TURN_PATH) {
        if (!outboundRoutesLive(env)) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        let raw = "";
        try {
          raw = await readBody(req, 16_384);
        } catch {
          sendJson(res, 413, { error: "body_too_large" });
          req.destroy();
          return;
        }
        const params = parseForm(raw);
        const url = signedWebhookUrl(config.publicBaseUrl, req);
        if (!config.twilioAuthToken || !url || !validateTwilioSignature(config.twilioAuthToken, headerValue(req.headers["x-twilio-signature"]), url, params)) {
          sendText(res, 403, "forbidden");
          return;
        }
        const token = new URL(req.url ?? "/", "http://local").searchParams.get("s");
        const xml = await runTurn(
          {
            cards: outboundCards,
            outcomes: outboundOutcomes,
            secret: outboundBearer(env),
            baseUrl: publicOrigin,
            now: deps.now ?? Date.now,
            env,
            labeler: deps.outboundLabeler,
          },
          token,
          params,
        );
        sendXml(res, xml);
        return;
      }
      if (path === OUTBOUND_STATUS_PATH) {
        let raw = "";
        try {
          raw = await readBody(req, 16_384);
        } catch {
          sendJson(res, 413, { error: "body_too_large" });
          req.destroy();
          return;
        }
        const reply = handleOutboundStatus(
          {
            env,
            store: outboundStore,
            onFinished: ({ approvalId, callSid, callStatus, seconds }) => {
              const nowMs = (deps.now ?? Date.now)();
              const approval = outboundStore.get(approvalId);
              const rec = outboundOutcomes.take(callSid);
              if (!approval?.cardId) return;
              const pinned = outboundCards.load(approval.cardId);
              const logged: LoggedOutcome = {
                ...(rec ?? {
                  callSid,
                  approvalId,
                  cardId: approval.cardId,
                  cardHash: approval.cardHash ?? "",
                  type: pinned.ok ? pinned.card.type : "unknown",
                  calleeName: pinned.ok ? pinned.card.callee.name : "unknown",
                  outcome: "no_answer" as const,
                  item: null,
                  pickup: null,
                  turns: 0,
                  labels: [],
                  startedAtMs: null,
                  refusal: null,
                }),
                endedAt: new Date(nowMs).toISOString(),
                durationSec: seconds,
                callStatus,
              };
              let lessons: string[] = [];
              try {
                appendOutcome(config.dataDir, logged);
                lessons = writeLessons(config.dataDir, logged.type, logged.endedAt).lessons;
              } catch {
                logWarn("outbound outcome log write failed");
              }
              track(
                postSummary({
                  url: config.summaryWebhookUrl,
                  secret: config.summaryWebhookSecret,
                  auth: config.summaryWebhookAuth,
                  summary: outboundSummary(logged, nowMs, lessons),
                  timeoutMs: config.summaryTimeoutMs,
                  maxAttempts: config.summaryMaxAttempts,
                  retryBaseMs: config.summaryRetryBaseMs,
                }).catch(() => {
                  logError("outbound summary delivery threw");
                  return undefined;
                }),
              );
            },
          },
          {
            method: req.method,
            authToken: config.twilioAuthToken,
            signature: headerValue(req.headers["x-twilio-signature"]),
            url: signedWebhookUrl(config.publicBaseUrl, req),
            params: parseForm(raw),
          },
        );
        sendJson(res, reply.status, reply.body, { "cache-control": "no-store" });
        return;
      }
      const reply = await handleOutbound(
        {
          env,
          store: outboundStore,
          client: deps.outboundClient,
          aiCheck: deps.outboundAiCheck,
          now: deps.now ?? Date.now,
          statusCallbackUrl:
            config.publicBaseUrl && !publicOriginError(config.publicBaseUrl, config.production)
              ? `${config.publicBaseUrl.replace(/\/+$/, "")}${OUTBOUND_STATUS_PATH}`
              : undefined,
          schedule: deps.outboundSchedule,
          cards: outboundCards,
          turnBaseUrl: publicOrigin,
        },
        {
          path,
          method: req.method,
          authorization: outboundLimiter.allow(ip) ? headerValue(req.headers.authorization) : undefined,
          readBody: () => readBody(req, 8_192),
        },
      );
      sendJson(res, reply.status, reply.body, { "cache-control": "no-store" });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  return { server, wss, drain };
}
