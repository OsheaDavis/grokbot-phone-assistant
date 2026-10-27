import { outboundEnabled } from "./enabled.js";
import type { OutboundCallRequest, OutboundCallResult, OutboundTwilioClient } from "./dialer.js";

/**
 * Production REST client for the one outbound request. Only the dialer
 * invokes it; src/index.ts builds it only when outbound is enabled. The
 * fetch function is injectable so tests never reach the network. Errors
 * never include the auth token or the response body.
 */
export interface TwilioRestOptions {
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BASE = "https://api.twilio.com/2010-04-01/Accounts";

export function createTwilioRestClient(opts: TwilioRestOptions): OutboundTwilioClient {
  if (!/^AC[0-9a-fA-F]{32}$/.test(opts.accountSid)) throw new Error("bad_account_sid");
  if (typeof opts.authToken !== "string" || opts.authToken.length === 0) throw new Error("missing_auth_token");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = `${BASE}/${opts.accountSid}/Calls.json`;
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;

  async function create(request: OutboundCallRequest): Promise<OutboundCallResult> {
    if (request.record !== false) throw new Error("record_must_be_false");
    const form = new URLSearchParams();
    form.set("From", request.from);
    form.set("To", request.to);
    if ((request.twiml === undefined) === (request.url === undefined)) throw new Error("one_of_twiml_or_url");
    if (request.twiml !== undefined) form.set("Twiml", request.twiml);
    if (request.url !== undefined) {
      if (!request.url.startsWith("https://")) throw new Error("url_must_be_https");
      form.set("Url", request.url);
      form.set("Method", "POST");
    }
    if (request.machineDetection === "Enable") form.set("MachineDetection", "Enable");
    form.set("Record", "false");
    form.set("TimeLimit", String(request.timeLimit));
    if (request.statusCallback) {
      form.set("StatusCallback", request.statusCallback);
      form.set("StatusCallbackMethod", "POST");
      form.set("StatusCallbackEvent", "completed");
    }
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`twilio_status_${res.status}`);
    const json = (await res.json()) as { sid?: unknown };
    if (typeof json?.sid !== "string") throw new Error("twilio_no_sid");
    return { sid: json.sid };
  }

  return { calls: { create } };
}

/** The REST client exists only when outbound is enabled; off means identical inbound behavior. */
export function outboundClientFor(
  env: NodeJS.ProcessEnv,
  creds: { accountSid: string | undefined; authToken: string | undefined },
  fetchImpl?: typeof fetch,
): OutboundTwilioClient | undefined {
  if (!outboundEnabled(env) || !creds.accountSid || !creds.authToken) return undefined;
  try {
    return createTwilioRestClient({ accountSid: creds.accountSid, authToken: creds.authToken, fetchImpl });
  } catch {
    return undefined;
  }
}
