import { safeEqual } from "../safe-equal.js";
import { ApprovalStore, type DialApproval } from "./approval.js";
import { OUTBOUND_FROM_NUMBER } from "./constants.js";
import { outboundBearer, outboundBearerOk, outboundEnabled } from "./enabled.js";
import { allowlistRefusal, type AllowlistRefusal } from "./dial-allowlist.js";
import { localDayKey, withinCallingWindow } from "./limits.js";
import { loadCallbackNumber, type CallbackRefusal } from "./callback.js";
import type { CardStore } from "./card.js";
import { TURN_LINK_TTL_MS, turnUrl } from "./turn.js";

/** Stage 2 wiring. When present, every dial needs a pinned context card. */
export interface Stage2DialDeps {
  cards: CardStore;
  baseUrl: string;
}

/** What the injected client accepts. `record` is the literal false. */
export interface OutboundCallRequest {
  from: typeof OUTBOUND_FROM_NUMBER;
  to: string;
  record: false;
  /** Seconds. The lesser of 10 minutes and the daily minutes still left. */
  timeLimit: number;
  /** Inline TwiML. Not used by the dialer (stage 2 always sends url); kept for the REST client contract. */
  twiml?: string;
  /** Signed /outbound/turn URL Twilio fetches when answered. Exactly one of twiml/url. */
  url?: string;
  /** Stage 2: answering-machine detection, so voicemail gets a silent hangup. */
  machineDetection?: "Enable";
  /** Signed Twilio status callback that marks the call finished. */
  statusCallback?: string;
}

/** Extra seconds past timeLimit before the safety timeout frees the line. */
export const FINISH_GRACE_SECONDS = 120;

export interface OutboundCallResult {
  sid: string;
}

/**
 * Injected telephony client. Production is the REST client module,
 * built in src/index.ts only when outbound is enabled. Tests pass a fake.
 */
export interface OutboundTwilioClient {
  calls: {
    create(request: OutboundCallRequest): Promise<OutboundCallResult>;
  };
}

export interface DialRequest {
  approvalId: string;
  code: string;
  confirmNumber: string;
  bearerHeader: string | undefined;
}

export type DialRefusal =
  | "feature_off"
  | "unauthorized"
  | "no_approval"
  | "expired"
  | "bad_code"
  | "number_mismatch"
  | "outside_window"
  | "reused"
  | "busy"
  | "over_call_cap"
  | "over_minute_cap"
  | "twilio_failed"
  | "card_missing"
  | "card_invalid"
  | "card_hash_mismatch"
  | "card_number_mismatch"
  | AllowlistRefusal
  | CallbackRefusal;

export type DialResult =
  | { ok: true; callSid: string; from: typeof OUTBOUND_FROM_NUMBER; record: false; approval: DialApproval }
  | { ok: false; reason: DialRefusal };

function validSid(sid: unknown): sid is string {
  return typeof sid === "string" && /^[A-Za-z0-9]{2,64}$/.test(sid);
}

/**
 * Places one call for one DialApproval. The from-number is fixed. Recording
 * is off. A lost compare-and-swap, a failed attempt, or a second use does
 * not call Twilio again. Creating a card does not go through this function.
 */
export async function dialApprovedCall(opts: {
  store: ApprovalStore;
  client: OutboundTwilioClient;
  request: DialRequest;
  now: number;
  env: NodeJS.ProcessEnv;
  statusCallbackUrl?: string;
  /** Safety timeout scheduler. Default is an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Required: every dial needs a pinned context card. */
  stage2: Stage2DialDeps;
}): Promise<DialResult> {
  if (!outboundEnabled(opts.env)) return { ok: false, reason: "feature_off" };
  if (!outboundBearerOk(opts.request.bearerHeader, opts.env)) {
    return { ok: false, reason: "unauthorized" };
  }
  const secret = outboundBearer(opts.env);
  if (!secret) return { ok: false, reason: "unauthorized" };

  const approvalId = opts.request.approvalId;
  if (typeof approvalId !== "string" || approvalId.length === 0 || approvalId.length > 80) {
    return { ok: false, reason: "no_approval" };
  }
  const approval = opts.store.get(approvalId);
  if (!approval) return { ok: false, reason: "no_approval" };
  if (!Number.isFinite(opts.now) || opts.now >= approval.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (approval.status !== "ready") return { ok: false, reason: "reused" };

  const code = opts.request.code;
  if (typeof code !== "string" || code.length < 16 || code.length > 128) {
    return { ok: false, reason: "bad_code" };
  }
  if (!opts.store.verifyCode(approvalId, code, secret)) {
    return { ok: false, reason: "bad_code" };
  }
  const confirm = opts.request.confirmNumber;
  if (typeof confirm !== "string" || !safeEqual(confirm, approval.number)) {
    return { ok: false, reason: "number_mismatch" };
  }
  // Fail-closed allowlist, checked again right before any dial.
  const blocked = allowlistRefusal(approval.number, opts.env);
  if (blocked) return { ok: false, reason: blocked };
  // Context card: re-load and re-hash at dial time; it must equal the approved hash.
  type PinResult = { ok: true; maxSeconds: number } | { ok: false; reason: DialRefusal };
  const pinCard = (): PinResult => {
    if (!opts.stage2) return { ok: false, reason: "card_missing" };
    if (!approval.cardId || !approval.cardHash) return { ok: false as const, reason: "card_missing" as const };
    const pinned = opts.stage2.cards.loadPinned(approval.cardId, approval.cardHash);
    if (!pinned.ok) {
      const reason: DialRefusal = pinned.error === "card_hash_mismatch" ? "card_hash_mismatch" : pinned.error === "card_missing" ? "card_missing" : "card_invalid";
      return { ok: false as const, reason };
    }
    const resolved = opts.stage2.cards.resolveNumber(pinned.card.callee.numberRef);
    if (!resolved || !safeEqual(resolved, approval.number)) return { ok: false as const, reason: "card_number_mismatch" as const };
    return { ok: true as const, maxSeconds: pinned.card.end.maxSeconds };
  };
  const pin = pinCard();
  if (!pin.ok) return { ok: false, reason: pin.reason };
  // Fail-closed callback number: no opener, no dial without one.
  const callback = loadCallbackNumber(opts.env);
  if (!callback.ok) return { ok: false, reason: callback.reason };
  if (!withinCallingWindow(opts.now)) return { ok: false, reason: "outside_window" };
  const dayKey = localDayKey(opts.now);
  if (!dayKey) return { ok: false, reason: "outside_window" };

  const begun = opts.store.beginDial(approvalId, dayKey);
  if (!begun.ok) return { ok: false, reason: begun.reason };

  // Re-check after the swap so nothing between the checks can widen it.
  const blockedLate = allowlistRefusal(approval.number, opts.env);
  if (blockedLate) {
    opts.store.failDial(approvalId);
    return { ok: false, reason: blockedLate };
  }
  const pinLate = pinCard();
  if (!pinLate.ok) {
    opts.store.failDial(approvalId);
    return { ok: false, reason: pinLate.reason };
  }
  const timeLimit = Math.min(begun.timeLimitSeconds, pinLate.maxSeconds);
  const content = {
    url: turnUrl(
      opts.stage2.baseUrl,
      { a: approval.id, c: approval.cardId as string, h: approval.cardHash as string, n: 0, p: "start", r: 0, t: 0, e: opts.now + TURN_LINK_TTL_MS },
      secret,
    ),
    machineDetection: "Enable" as const,
  };
  // Sole Twilio call-create. The client is injected; nothing here uses the network.
  try {
    const created = await opts.client.calls.create({
      from: OUTBOUND_FROM_NUMBER,
      to: approval.number,
      record: false,
      timeLimit,
      ...content,
      ...(opts.statusCallbackUrl ? { statusCallback: opts.statusCallbackUrl } : {}),
    });
    if (!validSid(created?.sid)) {
      opts.store.failDial(approvalId);
      return { ok: false, reason: "twilio_failed" };
    }
    opts.store.placeDial(approvalId, created.sid);
    const placed = opts.store.get(approvalId);
    if (!placed || placed.status !== "placed") {
      opts.store.failDial(approvalId);
      return { ok: false, reason: "twilio_failed" };
    }
    // Safety net: if no terminal status arrives, free the line and count the full limit.
    const limitMs = timeLimit * 1000;
    const schedule =
      opts.schedule ??
      ((fn: () => void, ms: number) => {
        setTimeout(fn, ms).unref();
      });
    schedule(() => opts.store.finishCall(approvalId, limitMs), limitMs + FINISH_GRACE_SECONDS * 1000);
    return { ok: true, callSid: created.sid, from: OUTBOUND_FROM_NUMBER, record: false, approval: placed };
  } catch {
    opts.store.failDial(approvalId);
    return { ok: false, reason: "twilio_failed" };
  }
}
