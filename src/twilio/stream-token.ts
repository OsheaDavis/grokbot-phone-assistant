import crypto from "node:crypto";

import { safeEqual } from "../safe-equal.js";

const MAX_TTL_SEC = 3600;
const CLOCK_SKEW_SEC = 30;

export function signStreamToken(
  secret: string,
  exp: number,
  callSid: string,
  from: string,
  startedAtMs: number,
): string {
  const payload = `${exp}.${callSid}.${from}.${startedAtMs}`;
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export interface MediaStreamPath {
  callSid: string;
  expRaw: string;
  from: string;
  startedAtRaw: string;
  token: string;
}

const MEDIA_STREAM_PATH = /^\/media-stream\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * Twilio's `<Stream url>` does not support query strings. The grant is the path
 * `/media-stream/<callSid>/<exp>/<t>/<from base64url>/<token>`.
 */
export function mediaStreamUrl(
  publicBaseUrl: string,
  parts: { exp: string; callSid: string; from: string; t: string; token: string },
): string {
  const base = new URL(publicBaseUrl);
  if (base.protocol === "https:") base.protocol = "wss:";
  else if (base.protocol === "http:") base.protocol = "ws:";
  else if (base.protocol !== "wss:" && base.protocol !== "ws:") {
    throw new Error("unsupported public base url");
  }
  const from = Buffer.from(parts.from, "utf8").toString("base64url");
  const segments = [parts.callSid, parts.exp, parts.t, from, parts.token].map((segment) =>
    encodeURIComponent(segment),
  );
  base.pathname = `/media-stream/${segments.join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** True for an upgrade aimed at the media stream, including a malformed grant. */
export function isMediaStreamUpgrade(requestUrl: string): boolean {
  const hashless = requestUrl.split("#")[0] ?? "";
  const pathOnly = hashless.split("?")[0] ?? "";
  try {
    const pathname = new URL(pathOnly, "http://localhost").pathname;
    return pathname === "/media-stream" || pathname.startsWith("/media-stream/");
  } catch {
    return false;
  }
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function decodeStreamFrom(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const from = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(from, "utf8").toString("base64url") !== encoded) return null;
  return from;
}

/** Path grant, or null when the URL has a query string or the wrong segments. */
export function parseMediaStreamPath(requestUrl: string): MediaStreamPath | null {
  if (requestUrl.includes("?") || requestUrl.includes("#")) return null;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://localhost").pathname;
  } catch {
    return null;
  }
  const match = MEDIA_STREAM_PATH.exec(pathname);
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) return null;
  const callSid = safeDecode(match[1]);
  const expRaw = safeDecode(match[2]);
  const startedAtRaw = safeDecode(match[3]);
  const fromEncoded = safeDecode(match[4]);
  const token = safeDecode(match[5]);
  if (!callSid || !expRaw || !startedAtRaw || !fromEncoded || !token) return null;
  const from = decodeStreamFrom(fromEncoded);
  if (from === null) return null;
  return { callSid, expRaw, from, startedAtRaw, token };
}

export interface IssuedStream {
  exp: number;
  token: string;
  insecure: boolean;
}

export function issueStreamCredentials(opts: {
  secret: string | undefined;
  callSid: string;
  from: string;
  startedAtMs: number;
  nowSec: number;
  production: boolean;
  allowInsecureDev: boolean;
  ttlSec?: number;
}): IssuedStream | null {
  const exp = opts.nowSec + (opts.ttlSec ?? 600);
  if (!opts.secret) {
    if (!opts.production && opts.allowInsecureDev) {
      return { exp, token: "insecure", insecure: true };
    }
    return null;
  }
  return {
    exp,
    token: signStreamToken(opts.secret, exp, opts.callSid, opts.from, opts.startedAtMs),
    insecure: false,
  };
}

export interface VerifiedStream {
  ok: true;
  callSid: string;
  from: string;
  startedAtMs: number;
  exp: number;
}

export interface RejectedStream {
  ok: false;
}

export function verifyStreamToken(opts: {
  secret: string | undefined;
  expRaw: string | null;
  callSid: string | null;
  from: string | null;
  startedAtRaw: string | null;
  token: string | null;
  nowSec: number;
  production: boolean;
  allowInsecureDev: boolean;
}): VerifiedStream | RejectedStream {
  const callSid = opts.callSid ?? "";
  const from = opts.from ?? "";
  const token = opts.token ?? "";
  if (!/^[A-Za-z0-9]{1,64}$/.test(callSid)) return { ok: false };
  const exp = Number(opts.expRaw);
  if (!Number.isInteger(exp)) return { ok: false };
  if (exp < opts.nowSec - CLOCK_SKEW_SEC) return { ok: false };
  if (exp > opts.nowSec + MAX_TTL_SEC) return { ok: false };
  const startedAtMs = Number(opts.startedAtRaw);
  if (!Number.isInteger(startedAtMs)) return { ok: false };
  const nowMs = opts.nowSec * 1000;
  if (startedAtMs < nowMs - 3_600_000 || startedAtMs > nowMs + 60_000) return { ok: false };
  if (!opts.secret) {
    if (!opts.production && opts.allowInsecureDev && token === "insecure") {
      return { ok: true, callSid, from, startedAtMs, exp };
    }
    return { ok: false };
  }
  const expected = signStreamToken(opts.secret, exp, callSid, from, startedAtMs);
  if (!safeEqual(expected, token)) return { ok: false };
  return { ok: true, callSid, from, startedAtMs, exp };
}

export interface CachedGrant {
  exp: number;
  token: string;
  from: string;
  startedAtMs: number;
}

const grantsByCall = new Map<string, CachedGrant>();
const claimed = new Map<string, number>();

function grantIdentity(callSid: string, exp: number, startedAtMs: number): string {
  return `${callSid}.${exp}.${startedAtMs}`;
}

function pruneGrants(nowSec: number): void {
  for (const [callSid, grant] of grantsByCall) {
    if (grant.exp < nowSec - CLOCK_SKEW_SEC) grantsByCall.delete(callSid);
  }
  for (const [key, exp] of claimed) {
    if (exp < nowSec - CLOCK_SKEW_SEC) claimed.delete(key);
  }
}

/** Reuse the token for a Twilio retry of the same CallSid instead of minting another. */
export function rememberStreamGrant(callSid: string, grant: CachedGrant, nowSec: number): void {
  pruneGrants(nowSec);
  grantsByCall.set(callSid, grant);
}

export function lookupStreamGrant(callSid: string, nowSec: number): CachedGrant | null {
  pruneGrants(nowSec);
  const grant = grantsByCall.get(callSid);
  if (!grant) return null;
  if (grant.exp < nowSec - CLOCK_SKEW_SEC) {
    grantsByCall.delete(callSid);
    return null;
  }
  return grant;
}

/** One media socket per grant. A second upgrade cannot open another xAI session. */
export function claimStreamGrant(callSid: string, exp: number, startedAtMs: number, nowSec: number): boolean {
  pruneGrants(nowSec);
  const key = grantIdentity(callSid, exp, startedAtMs);
  if (claimed.has(key)) return false;
  claimed.set(key, exp);
  return true;
}

export function clearStreamGrantsForTests(): void {
  grantsByCall.clear();
  claimed.clear();
}
