import type { CallerLists } from "../callers.js";
import { isListed } from "../callers.js";
import { isAnonymousCaller, normalizeCallerNumber } from "../phone.js";
import type { CallFlag } from "../types.js";

export class RepeatTracker {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Record a call. True when this hit exceeds the allowed count in the window. */
  observe(key: string, now = Date.now()): boolean {
    const start = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((stamp) => stamp > start);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [id, stamps] of this.hits) {
        const last = stamps[stamps.length - 1];
        if (last === undefined || last <= start) this.hits.delete(id);
      }
    }
    return recent.length > this.max;
  }
}

export interface ScreenResult {
  action: "connect" | "block" | "spam";
  flags: CallFlag[];
  callerNumber: string | null;
}

/** Blocklist and allowlist check that does not count toward the repeat limit. */
export function classifyCaller(from: string | undefined, lists: CallerLists): ScreenResult {
  const raw = from ?? "";
  if (raw.trim().length > 64) {
    return { action: "spam", flags: ["spam"], callerNumber: null };
  }
  if (isAnonymousCaller(from)) {
    return { action: "spam", flags: ["spam"], callerNumber: null };
  }
  const callerNumber = normalizeCallerNumber(from);
  const blocked =
    (callerNumber !== null && isListed(callerNumber, lists.blocklist)) || isListed(raw, lists.blocklist);
  if (blocked) {
    return { action: "block", flags: ["blocked"], callerNumber };
  }
  const flags: CallFlag[] = [];
  const allowed =
    (callerNumber !== null && isListed(callerNumber, lists.allowlist)) || isListed(raw, lists.allowlist);
  if (allowed) flags.push("allowlisted");
  if (!callerNumber && !allowed) {
    return { action: "spam", flags: ["spam"], callerNumber: null };
  }
  return { action: "connect", flags, callerNumber };
}

export function screenCaller(
  from: string | undefined,
  lists: CallerLists,
  repeat: RepeatTracker,
  nowMs = Date.now(),
): ScreenResult {
  const result = classifyCaller(from, lists);
  if (result.action !== "connect" || result.flags.includes("allowlisted") || !result.callerNumber) {
    return result;
  }
  if (repeat.observe(result.callerNumber, nowMs)) {
    return { action: "spam", flags: ["spam"], callerNumber: result.callerNumber };
  }
  return result;
}
