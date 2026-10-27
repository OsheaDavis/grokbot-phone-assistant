import crypto from "node:crypto";
import type http from "node:http";

import { safeEqual } from "../safe-equal.js";

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) {
    data += key + (params[key] ?? "");
  }
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  return safeEqual(expected, signature);
}

export type SignatureDecision = "ok" | "rejected";

export function signatureDecision(opts: {
  production: boolean;
  authToken: string | undefined;
  allowInsecureDev: boolean;
  signature: string | undefined;
  url: string;
  params: Record<string, string>;
}): SignatureDecision {
  if (!opts.authToken) {
    if (!opts.production && opts.allowInsecureDev) return "ok";
    return "rejected";
  }
  return validateTwilioSignature(opts.authToken, opts.signature, opts.url, opts.params) ? "ok" : "rejected";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Why a configured origin cannot be used.
 * "insecure" is http, which non-production may still use for local tunnels.
 */
export function publicOriginError(publicBaseUrl: string | undefined, production: boolean): string | null {
  if (!publicBaseUrl) return production ? "missing" : null;
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    return "invalid";
  }
  if (parsed.username || parsed.password) return "credentials";
  if (parsed.search || parsed.hash) return "query";
  if (parsed.pathname !== "/" && parsed.pathname !== "") return "path";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "scheme";
  if (production && parsed.protocol !== "https:") return "insecure";
  return null;
}

/** URL Twilio signed. PUBLIC_BASE_URL wins so a proxy host cannot change the signed URL. */
export function signedWebhookUrl(publicBaseUrl: string | undefined, req: http.IncomingMessage): string | null {
  const raw = req.url ?? "/voice";
  const pathAndQuery = raw.startsWith("/") ? raw : `/${raw}`;
  if (publicBaseUrl) {
    if (publicOriginError(publicBaseUrl, false)) return null;
    return `${publicBaseUrl.replace(/\/+$/, "")}${pathAndQuery}`;
  }
  const hostHeader = headerValue(req.headers["x-forwarded-host"]) ?? headerValue(req.headers.host);
  if (!hostHeader) return null;
  const host = hostHeader.split(",")[0]?.trim() ?? "";
  if (!host || host.length > 255 || /[\s/@\\]/.test(host)) return null;
  const protoHeader = headerValue(req.headers["x-forwarded-proto"]) ?? "https";
  const proto = protoHeader.split(",")[0]?.trim().toLowerCase() ?? "";
  if (proto !== "https" && proto !== "http") return null;
  return `${proto}://${host}${pathAndQuery}`;
}
