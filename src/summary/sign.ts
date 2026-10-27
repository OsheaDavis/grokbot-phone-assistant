import crypto from "node:crypto";

import { safeEqual } from "../safe-equal.js";

export const SUMMARY_SIGNATURE_PREFIX = "sha256=";
export const DEFAULT_REPLAY_WINDOW_SEC = 300;

/** HMAC-SHA256 over `${timestamp}.${rawBody}`. Timestamp is included so a captured body cannot be replayed later. */
export function signSummary(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

export function summarySignatureHeader(hex: string): string {
  return `${SUMMARY_SIGNATURE_PREFIX}${hex}`;
}

export function verifySummary(opts: {
  secret: string;
  timestamp: string;
  rawBody: string;
  signatureHeader: string | undefined;
  nowSec: number;
  windowSec?: number;
}): boolean {
  const windowSec = opts.windowSec ?? DEFAULT_REPLAY_WINDOW_SEC;
  if (!/^\d{1,12}$/.test(opts.timestamp)) return false;
  const stamped = Number(opts.timestamp);
  if (!Number.isFinite(stamped)) return false;
  if (Math.abs(opts.nowSec - stamped) > windowSec) return false;
  const header = opts.signatureHeader ?? "";
  if (!header.startsWith(SUMMARY_SIGNATURE_PREFIX)) return false;
  const got = header.slice(SUMMARY_SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  const expected = signSummary(opts.secret, opts.timestamp, opts.rawBody);
  return safeEqual(expected, got);
}
