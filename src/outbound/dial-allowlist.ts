import { safeEqual } from "../safe-equal.js";
import { validateUsDialNumber } from "./number.js";

/**
 * Single-number outbound allowlist, read from OUTBOUND_ALLOWLIST
 * (comma-separated canonical E.164). Fail closed: a missing, empty, or
 * malformed value allows no numbers at all. Every entry must pass the
 * strict US dial check; one bad entry voids the whole list. Stage 1 caps
 * the list at one number. Refusals never echo the env value.
 */
export const OUTBOUND_ALLOWLIST_MAX = 1;

export type AllowlistLoad =
  | { ok: true; numbers: readonly string[] }
  | { ok: false; reason: "allowlist_missing" | "allowlist_malformed" };

export function loadOutboundAllowlist(env: NodeJS.ProcessEnv): AllowlistLoad {
  const raw = env.OUTBOUND_ALLOWLIST;
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, reason: "allowlist_missing" };
  if (raw.length > 200) return { ok: false, reason: "allowlist_malformed" };
  const parts = raw.split(",").map((p) => p.trim());
  const numbers: string[] = [];
  for (const part of parts) {
    const check = validateUsDialNumber(part);
    if (!check.ok) return { ok: false, reason: "allowlist_malformed" };
    if (!numbers.includes(check.e164)) numbers.push(check.e164);
  }
  if (numbers.length === 0 || numbers.length > OUTBOUND_ALLOWLIST_MAX) {
    return { ok: false, reason: "allowlist_malformed" };
  }
  return { ok: true, numbers };
}

export type AllowlistRefusal = "allowlist_missing" | "allowlist_malformed" | "not_allowlisted";

/** null means allowed. */
export function allowlistRefusal(number: string, env: NodeJS.ProcessEnv): AllowlistRefusal | null {
  const list = loadOutboundAllowlist(env);
  if (!list.ok) return list.reason;
  if (typeof number !== "string") return "not_allowlisted";
  let hit = false;
  for (const n of list.numbers) if (safeEqual(n, number)) hit = true;
  return hit ? null : "not_allowlisted";
}
