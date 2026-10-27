import { safeEqual } from "../safe-equal.js";
import { OUTBOUND_FROM_NUMBER } from "./constants.js";
import { loadOutboundAllowlist } from "./dial-allowlist.js";
import { validateUsDialNumber } from "./number.js";

/**
 * Callback number spoken in the outbound opener, read from
 * OUTBOUND_CALLBACK_NUMBER (canonical US E.164). Ported from the
 * outbound-opener-example branch (3732ed1). Fail closed: unset, malformed,
 * equal to the bot's own Twilio line, or equal to any OUTBOUND_ALLOWLIST
 * entry means no approval and no dial. Comparisons run at runtime; the
 * value is never echoed in a refusal or log. No number is hardcoded here.
 */
export const OUTBOUND_CALLBACK_ENV = "OUTBOUND_CALLBACK_NUMBER";

export type CallbackRefusal = "callback_missing" | "callback_malformed" | "callback_is_bot_line" | "callback_in_allowlist";

export type CallbackLoad = { ok: true; e164: string } | { ok: false; reason: CallbackRefusal };

export function loadCallbackNumber(env: NodeJS.ProcessEnv): CallbackLoad {
  const raw = env[OUTBOUND_CALLBACK_ENV];
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, reason: "callback_missing" };
  const value = raw.trim();
  if (value.length > 20 || !/^\+1\d{10}$/.test(value)) return { ok: false, reason: "callback_malformed" };
  const check = validateUsDialNumber(value);
  if (!check.ok || check.e164 !== value) return { ok: false, reason: "callback_malformed" };
  if (safeEqual(check.e164, OUTBOUND_FROM_NUMBER)) return { ok: false, reason: "callback_is_bot_line" };
  const list = loadOutboundAllowlist(env);
  if (list.ok) {
    let hit = false;
    for (const n of list.numbers) if (safeEqual(n, check.e164)) hit = true;
    if (hit) return { ok: false, reason: "callback_in_allowlist" };
  }
  return { ok: true, e164: check.e164 };
}

/** null means a valid callback number is configured. */
export function callbackRefusal(env: NodeJS.ProcessEnv): CallbackRefusal | null {
  const load = loadCallbackNumber(env);
  return load.ok ? null : load.reason;
}

/** "+12025550100" -> "202-555-0100" for speech. */
export function formatCallback(e164: string): string {
  const d = e164.slice(2);
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
