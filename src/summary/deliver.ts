import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

import { logWarn } from "../logger.js";
import type { CallSummary } from "../types.js";
import { serializeSummary } from "./payload.js";
import { signSummary, summarySignatureHeader } from "./sign.js";

/**
 * Addresses the webhook must not connect to.
 * IPv4: unspecified (0.0.0.0/8), private, loopback, link-local, and CGNAT.
 * IPv6: unspecified, loopback, unique-local (fc00::/7), link-local,
 * NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48), and 6to4 (2002::/16).
 * BlockList also applies the IPv4 rules to IPv4-mapped IPv6 addresses.
 */
const BLOCKED_HOSTS = new net.BlockList();
BLOCKED_HOSTS.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED_HOSTS.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED_HOSTS.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED_HOSTS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_HOSTS.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED_HOSTS.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED_HOSTS.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED_HOSTS.addAddress("::", "ipv6");
BLOCKED_HOSTS.addAddress("::1", "ipv6");
BLOCKED_HOSTS.addSubnet("fc00::", 7, "ipv6");
BLOCKED_HOSTS.addSubnet("fe80::", 10, "ipv6");
BLOCKED_HOSTS.addSubnet("64:ff9b::", 96, "ipv6");
BLOCKED_HOSTS.addSubnet("64:ff9b:1::", 48, "ipv6");
BLOCKED_HOSTS.addSubnet("2002::", 16, "ipv6");

/** RFC 9110 auth-scheme: one token, then one or more spaces. */
const AUTH_SCHEME_PREFIX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+ +/;

/**
 * Authorization header value. A value that already has a scheme prefix is sent unchanged.
 * Any other value is sent as "Bearer <value>".
 */
export function summaryAuthorizationValue(auth: string): string {
  if (AUTH_SCHEME_PREFIX.test(auth)) return auth;
  return `Bearer ${auth}`;
}

export interface DeliverOptions {
  url: string | undefined;
  secret: string | undefined;
  /** SUMMARY_WEBHOOK_AUTH. Omitted from the request when unset. Never logged. */
  auth?: string;
  summary: CallSummary;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  /**
   * Test seam for the signed body. Production leaves this unset and posts with https.request.
   * A caller-supplied fetch is not the delivery path.
   */
  fetchImpl?: typeof fetch;
  /** Test trust anchor. Production verifies the certificate against the default CA store and the hostname. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** Test seam. Production resolves with dns.lookup and requires every address to be public. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliverResult {
  status: "skipped" | "delivered" | "failed";
  attempts: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function stripZone(address: string): string {
  const zone = address.indexOf("%");
  return zone === -1 ? address : address.slice(0, zone);
}

function bareHostname(hostname: string): string {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return stripZone(bare);
}

function normalizeAddress(address: string): string {
  return stripZone(address).toLowerCase();
}

function isBlockedAddress(address: string): boolean {
  const bare = normalizeAddress(address);
  const kind = net.isIP(bare);
  if (kind === 4) return BLOCKED_HOSTS.check(bare, "ipv4");
  if (kind === 6) return BLOCKED_HOSTS.check(bare, "ipv6");
  return true;
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * One public address to connect to, or undefined when the host must be refused.
 * Every answer has to be public. A lookup failure refuses the host.
 * The socket is pinned to the first answer so a later lookup cannot move it.
 */
async function vettedAddress(
  hostname: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<string | undefined> {
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return undefined;
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return undefined;
  let pinned: string | undefined;
  for (const candidate of addresses) {
    if (typeof candidate !== "string" || candidate.length === 0) return undefined;
    const address = normalizeAddress(candidate);
    if (!address || isBlockedAddress(address)) return undefined;
    if (!pinned) pinned = address;
  }
  return pinned;
}

/** Lookup that never calls DNS. Every invocation returns the same vetted address. */
function pinnedLookup(address: string): LookupFunction {
  const family: 4 | 6 = net.isIP(address) === 6 ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function timeoutError(): Error {
  const err = new Error("timeout");
  err.name = "TimeoutError";
  return err;
}

/**
 * POST to the pinned address. Host and SNI stay on the URL hostname so the certificate
 * is checked against that name. Redirects are not followed; the caller treats 3xx as failure.
 */
function postPinned(
  endpoint: URL,
  hostname: string,
  address: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  ca: DeliverOptions["ca"],
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err: Error | null, status?: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(status ?? 0);
    };
    const requestOptions: https.RequestOptions = {
      method: "POST",
      protocol: "https:",
      hostname,
      servername: hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      agent: false,
      rejectUnauthorized: true,
      headers: {
        ...headers,
        host: endpoint.host,
        "content-length": Buffer.byteLength(body).toString(),
      },
      lookup: pinnedLookup(address),
    };
    if (ca !== undefined) requestOptions.ca = ca;
    const req = https.request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.on("error", (err) => finish(err));
      res.on("end", () => finish(null, status));
    });
    req.on("error", (err) => finish(err));
    timer = setTimeout(() => {
      req.destroy(timeoutError());
    }, timeoutMs);
    req.end(body);
  });
}

/**
 * POST the summary. Never throws. Skips when the URL is unset.
 * Each attempt, including retries, resolves the host again and refuses any non-public address
 * before connecting. Retries are capped and each attempt has a timeout.
 * HMAC headers are sent only when secret is set. auth alone is enough to deliver.
 */
export async function deliverSummary(opts: DeliverOptions): Promise<DeliverResult> {
  if (!opts.url) return { status: "skipped", attempts: 0 };
  const auth = typeof opts.auth === "string" && opts.auth.length > 0 ? opts.auth : undefined;
  if (!opts.secret && !auth) {
    logWarn("summary webhook URL is set but the signing secret is missing; skipping delivery");
    return { status: "skipped", attempts: 0 };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(opts.url);
  } catch {
    logWarn("summary webhook URL is invalid; skipping delivery");
    return { status: "skipped", attempts: 0 };
  }
  if (endpoint.protocol !== "https:") {
    logWarn("summary webhook URL is not https; skipping delivery");
    return { status: "skipped", attempts: 0 };
  }
  const hostname = bareHostname(endpoint.hostname);
  if (!hostname) {
    logWarn("summary webhook host is not a public address; skipping delivery");
    return { status: "skipped", attempts: 0 };
  }

  const body = serializeSummary(opts.summary);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "phone-assistant/phase1",
  };
  if (opts.secret) {
    const timestamp = Math.floor((opts.nowMs ?? Date.now)() / 1000).toString();
    const signature = summarySignatureHeader(signSummary(opts.secret, timestamp, body));
    headers["X-Summary-Timestamp"] = timestamp;
    headers["X-Summary-Signature"] = signature;
    // Same HMAC as X-Summary-Signature so either header verifies the timestamped body.
    headers["X-Signature"] = signature;
  }
  if (auth) headers.Authorization = summaryAuthorizationValue(auth);
  const resolveHost = opts.resolveHost ?? defaultResolveHost;
  const sleep = opts.sleep ?? defaultSleep;
  const attempts = Math.max(1, opts.maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const address = await vettedAddress(hostname, resolveHost);
    if (!address) {
      logWarn("summary webhook host is not a public address; skipping delivery");
      if (attempt === 1) return { status: "skipped", attempts: 0 };
      return { status: "failed", attempts: attempt - 1 };
    }
    try {
      const status = opts.fetchImpl
        ? await postWithFetch(opts.fetchImpl, endpoint, headers, body, opts.timeoutMs)
        : await postPinned(endpoint, hostname, address, body, headers, opts.timeoutMs, opts.ca);
      if (status >= 300 && status < 400) {
        logWarn(`summary webhook redirect status=${status} attempt=${attempt}`);
        return { status: "failed", attempts: attempt };
      }
      if (status >= 200 && status < 300) return { status: "delivered", attempts: attempt };
      logWarn(`summary webhook failed status=${status} attempt=${attempt}`);
      if (!shouldRetry(status) || attempt === attempts) {
        return { status: "failed", attempts: attempt };
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      logWarn(`summary webhook error attempt=${attempt} name=${name}`);
      if (attempt === attempts) return { status: "failed", attempts: attempt };
    }
    await sleep(opts.retryBaseMs * attempt);
  }
  return { status: "failed", attempts };
}

async function postWithFetch(
  fetchImpl: typeof fetch,
  endpoint: URL,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<number> {
  const response = await fetchImpl(endpoint.toString(), {
    method: "POST",
    redirect: "error",
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}
