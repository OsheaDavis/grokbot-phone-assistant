import crypto from "node:crypto";

import { looksLikeInjection } from "../injection.js";
import { safeEqual } from "../safe-equal.js";
import { DAILY_CALL_CAP, DAILY_MINUTE_CAP, MAX_APPROVAL_MS, MAX_CALL_SECONDS, MIN_CALL_SECONDS } from "./constants.js";
import { outboundBearer, outboundBearerOk } from "./enabled.js";
import { allowlistRefusal, type AllowlistRefusal } from "./dial-allowlist.js";
import { callbackRefusal, type CallbackRefusal } from "./callback.js";
import { validateUsDialNumber } from "./number.js";
import { carriesDonorPitch } from "./opener.js";

declare const dialApprovalBrand: unique symbol;

export type ApprovalStatus = "ready" | "dialing" | "placed" | "failed" | "burned";

/**
 * One approved outbound card. This is not the inbound media-stream grant.
 * Only createApprovalCard produces one. The one-time code is not stored.
 */
export interface DialApproval {
  readonly [dialApprovalBrand]: "DialApproval";
  readonly id: string;
  readonly business: string;
  readonly number: string;
  readonly purpose: string;
  readonly slotNames: readonly string[];
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly status: ApprovalStatus;
  readonly callSid: string | null;
  /** Stage 2 context card bound into the one-time code. Null only for direct (non-route) stage 1 use. */
  readonly cardId: string | null;
  readonly cardHash: string | null;
}

export interface ApprovalCardInput {
  business: string;
  number: string;
  purpose: string;
  slotNames: readonly string[];
  ttlMs: number;
  /** Context card id and sha256, already loaded and checked by the caller. */
  card?: { id: string; hash: string };
}

export type CreateRefusal =
  | "unauthorized"
  | "invalid_number"
  | "non_us"
  | "premium"
  | "bad_business"
  | "bad_purpose"
  | "bad_slots"
  | "bad_expiry"
  | "injection"
  | "bad_card"
  | AllowlistRefusal
  | CallbackRefusal;

export type CreateResult =
  | { ok: true; approval: DialApproval; code: string }
  | { ok: false; reason: CreateRefusal };

export type BeginDialResult =
  | { ok: true; timeLimitSeconds: number }
  | { ok: false; reason: "reused" | "busy" | "over_call_cap" | "over_minute_cap" };

const TICKABLE_SLOTS = new Set(["name", "callback", "dob", "insurance", "vehicle", "address"]);

const FORBIDDEN_SLOTS = new Set([
  "ssn",
  "social",
  "card",
  "creditcard",
  "credit_card",
  "bank",
  "routing",
  "cvv",
  "password",
  "otp",
  "pin",
  "secret",
]);

const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;

interface Row {
  id: string;
  business: string;
  number: string;
  purpose: string;
  slotNames: string[];
  canonical: string;
  codeMac: string;
  expiresAt: number;
  createdAt: number;
  status: ApprovalStatus;
  callSid: string | null;
  dayKey: string | null;
  cardId: string | null;
  cardHash: string | null;
}

interface DayUsage {
  calls: number;
  /** Finished call time counted against the daily minute cap. */
  seconds: number;
}

/**
 * Stage 1 store. The ready → dialing transition is synchronous, so two
 * dials in this process cannot both win. A failed dial stays failed.
 */
export class ApprovalStore {
  private readonly rows = new Map<string, Row>();
  private activeId: string | null = null;
  private readonly usage = new Map<string, DayUsage>();

  private usageFor(dayKey: string): DayUsage {
    let row = this.usage.get(dayKey);
    if (!row) {
      row = { calls: 0, seconds: 0 };
      this.usage.set(dayKey, row);
    }
    return row;
  }

  get(id: string): DialApproval | null {
    const row = this.rows.get(id);
    return row ? toPublic(row) : null;
  }

  verifyCode(id: string, code: string, secret: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    if (typeof code !== "string" || typeof secret !== "string" || secret.length === 0) return false;
    const mac = approvalMac(secret, row.canonical, code);
    return safeEqual(mac, row.codeMac);
  }

  /**
   * Compare-and-swap ready → dialing. Also enforces one live call and the
   * daily caps. The call cap counts every attempt that wins this swap,
   * including a later Twilio failure, so a failure cannot be looped.
   */
  beginDial(id: string, dayKey: string): BeginDialResult {
    const row = this.rows.get(id);
    if (!row || row.status !== "ready") return { ok: false, reason: "reused" };
    if (this.activeId !== null) return { ok: false, reason: "busy" };
    const usage = this.usageFor(dayKey);
    if (usage.calls >= DAILY_CALL_CAP) return { ok: false, reason: "over_call_cap" };
    const remainingSeconds = DAILY_MINUTE_CAP * 60 - usage.seconds;
    if (remainingSeconds < MIN_CALL_SECONDS) return { ok: false, reason: "over_minute_cap" };
    const timeLimitSeconds = Math.min(MAX_CALL_SECONDS, remainingSeconds);
    row.status = "dialing";
    row.dayKey = dayKey;
    this.activeId = id;
    usage.calls += 1;
    return { ok: true, timeLimitSeconds };
  }

  placeDial(id: string, callSid: string): void {
    const row = this.rows.get(id);
    if (!row || row.status !== "dialing") return;
    row.status = "placed";
    row.callSid = callSid;
  }

  /** Terminal. The card is not returned to ready and cannot redial. */
  failDial(id: string): void {
    const row = this.rows.get(id);
    if (!row || row.status !== "dialing") return;
    row.status = "failed";
    row.callSid = null;
    if (this.activeId === id) this.activeId = null;
  }

  /** Call end. Minutes count against the Eastern day the dial started. */
  finishCall(id: string, durationMs: number): void {
    const row = this.rows.get(id);
    if (!row || row.status !== "placed") return;
    row.status = "burned";
    if (this.activeId === id) this.activeId = null;
    if (!row.dayKey) return;
    const seconds = Number.isFinite(durationMs) ? Math.ceil(Math.max(0, durationMs) / 1000) : 0;
    this.usageFor(row.dayKey).seconds += seconds;
  }

  /** Id of the placed call with this Twilio sid, or null. */
  findPlacedBySid(callSid: string): string | null {
    for (const row of this.rows.values()) {
      if (row.status === "placed" && row.callSid === callSid) return row.id;
    }
    return null;
  }

  /** True while a call holds the single line. */
  isBusy(): boolean {
    return this.activeId !== null;
  }

  insert(row: Row): void {
    this.rows.set(row.id, row);
  }
}

function toPublic(row: Row): DialApproval {
  return {
    id: row.id,
    business: row.business,
    number: row.number,
    purpose: row.purpose,
    slotNames: [...row.slotNames],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    status: row.status,
    callSid: row.callSid,
    cardId: row.cardId,
    cardHash: row.cardHash,
  } as unknown as DialApproval;
}

/** Length-prefixed so two different cards cannot share a canonical string. */
export function canonicalCardContents(input: {
  business: string;
  number: string;
  purpose: string;
  slotNames: readonly string[];
  card?: { id: string; hash: string };
}): string {
  const slots = input.slotNames.join("\n");
  const lines = [
    "v1",
    `business:${input.business.length}:${input.business}`,
    `number:${input.number}`,
    `purpose:${input.purpose.length}:${input.purpose}`,
    `slots:${input.slotNames.length}:${slots}`,
  ];
  if (input.card) lines.push(`card:${input.card.id.length}:${input.card.id}`, `cardhash:${input.card.hash}`);
  return lines.join("\n");
}

function approvalMac(secret: string, canonical: string, code: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${canonical}\ncode:${code.length}:${code}`, "utf8")
    .digest("hex");
}

function cleanText(value: string, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  if (CONTROL.test(trimmed)) return null;
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  if (carriesDonorPitch(trimmed)) return null;
  if (looksLikeInjection(trimmed)) return null;
  return trimmed;
}

function normalizeSlots(names: readonly string[]): string[] | null {
  if (!Array.isArray(names) || names.length > TICKABLE_SLOTS.size) return null;
  const out: string[] = [];
  for (const name of names) {
    if (typeof name !== "string") return null;
    const slot = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!slot || slot.length > 32) return null;
    const compact = slot.replace(/_/g, "");
    if (FORBIDDEN_SLOTS.has(slot) || FORBIDDEN_SLOTS.has(compact)) return null;
    if (!TICKABLE_SLOTS.has(slot)) return null;
    if (!out.includes(slot)) out.push(slot);
  }
  out.sort();
  return out;
}

/**
 * Stores a card and returns its one-time code. Does not take a telephony
 * client and does not dial. The code is bound to the business, number,
 * purpose, and slot names with HMAC. Slot values are not accepted.
 */
export function createApprovalCard(opts: {
  store: ApprovalStore;
  input: ApprovalCardInput;
  bearerHeader: string | undefined;
  env: NodeJS.ProcessEnv;
  now: number;
}): CreateResult {
  if (!outboundBearerOk(opts.bearerHeader, opts.env)) {
    return { ok: false, reason: "unauthorized" };
  }
  const secret = outboundBearer(opts.env);
  if (!secret) return { ok: false, reason: "unauthorized" };
  if (!Number.isFinite(opts.now)) return { ok: false, reason: "bad_expiry" };

  const business = cleanText(opts.input.business, 1, 80);
  if (!business) {
    return { ok: false, reason: looksLikeCardInjection(opts.input.business) ? "injection" : "bad_business" };
  }
  const purpose = cleanText(opts.input.purpose, 1, 200);
  if (!purpose) {
    return { ok: false, reason: looksLikeCardInjection(opts.input.purpose) ? "injection" : "bad_purpose" };
  }
  const numberCheck = validateUsDialNumber(opts.input.number);
  if (!numberCheck.ok) return { ok: false, reason: numberCheck.reason };
  const blocked = allowlistRefusal(numberCheck.e164, opts.env);
  if (blocked) return { ok: false, reason: blocked };
  const noCallback = callbackRefusal(opts.env);
  if (noCallback) return { ok: false, reason: noCallback };
  const slotNames = normalizeSlots(opts.input.slotNames);
  if (!slotNames) return { ok: false, reason: "bad_slots" };
  if (!Number.isSafeInteger(opts.input.ttlMs) || opts.input.ttlMs <= 0 || opts.input.ttlMs > MAX_APPROVAL_MS) {
    return { ok: false, reason: "bad_expiry" };
  }

  const card = opts.input.card;
  if (card !== undefined) {
    if (typeof card?.id !== "string" || !/^[a-z0-9-]{3,64}$/.test(card.id) || typeof card.hash !== "string" || !/^[0-9a-f]{64}$/.test(card.hash)) {
      return { ok: false, reason: "bad_card" };
    }
  }
  const canonical = canonicalCardContents({
    business,
    number: numberCheck.e164,
    purpose,
    slotNames,
    ...(card ? { card } : {}),
  });
  const code = crypto.randomBytes(18).toString("base64url");
  const row: Row = {
    id: crypto.randomUUID(),
    business,
    number: numberCheck.e164,
    purpose,
    slotNames,
    canonical,
    codeMac: approvalMac(secret, canonical, code),
    expiresAt: opts.now + opts.input.ttlMs,
    createdAt: opts.now,
    status: "ready",
    callSid: null,
    dayKey: null,
    cardId: card ? card.id : null,
    cardHash: card ? card.hash : null,
  };
  opts.store.insert(row);
  return { ok: true, approval: toPublic(row), code };
}

function looksLikeCardInjection(value: unknown): boolean {
  return typeof value === "string" && looksLikeInjection(value);
}
