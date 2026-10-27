import crypto from "node:crypto";

import { safeEqual } from "../safe-equal.js";
import { escapeXml } from "../twilio/twiml.js";
import type { CardStore, ContextCard } from "./card.js";
import { classifyReply, extractItem, extractPickup, type ItemType, type Label, type ReplyLabeler } from "./classify.js";
import { CALLBACK_PLACEHOLDER } from "./card.js";
import { formatCallback, loadCallbackNumber } from "./callback.js";
import { spokenName } from "./spoken.js";

export const OUTBOUND_TURN_PATH = "/outbound/turn";

export type Outcome = "yes" | "no" | "unclear" | "refused" | "declined" | "voicemail" | "no_answer" | "card_refused";

/** One call's result. Holds labels and fixed-vocabulary captures only, never transcripts. */
export interface OutcomeRecord {
  callSid: string;
  approvalId: string;
  cardId: string;
  cardHash: string;
  type: string;
  calleeName: string;
  outcome: Outcome;
  item: ItemType | null;
  pickup: string | null;
  turns: number;
  labels: Label[];
  startedAtMs: number | null;
  refusal: string | null;
}

export class OutcomeStore {
  private readonly rows = new Map<string, OutcomeRecord>();
  get(callSid: string): OutcomeRecord | undefined {
    return this.rows.get(callSid);
  }
  put(rec: OutcomeRecord): void {
    this.rows.set(rec.callSid, rec);
  }
  take(callSid: string): OutcomeRecord | undefined {
    const rec = this.rows.get(callSid);
    this.rows.delete(callSid);
    return rec;
  }
}

/** Signed per-turn state carried in the Gather action URL. */
export interface TurnState {
  a: string; // approval id
  c: string; // card id
  h: string; // card hash
  n: number; // gathers issued so far
  p: "start" | "ask" | "follow";
  r: number; // repeats used
  t: number; // answered-at ms (0 before the first turn)
  e: number; // link expiry ms; a turn after this hangs up
}

/** Each signed turn link lives this long. Expired or missing expiry fails closed. */
export const TURN_LINK_TTL_MS = 3 * 60 * 1000;

function mac(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(`turn:v1:${body}`, "utf8").digest("base64url");
}

export function signState(state: TurnState, secret: string): string {
  const body = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export function verifyState(token: unknown, secret: string | undefined, now: number): TurnState | null {
  if (!secret || typeof token !== "string" || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(mac(secret, body), sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TurnState;
    if (typeof s.a !== "string" || typeof s.c !== "string" || typeof s.h !== "string") return null;
    if (!Number.isSafeInteger(s.n) || !Number.isSafeInteger(s.r) || !Number.isSafeInteger(s.t)) return null;
    if (!Number.isSafeInteger(s.e) || !Number.isFinite(now) || now >= s.e || s.e - now > TURN_LINK_TTL_MS) return null;
    if (s.p !== "start" && s.p !== "ask" && s.p !== "follow") return null;
    return s;
  } catch {
    return null;
  }
}

export function turnUrl(base: string, state: TurnState, secret: string): string {
  return `${base.replace(/\/+$/, "")}${OUTBOUND_TURN_PATH}?s=${encodeURIComponent(signState(state, secret))}`;
}

/**
 * The only path from card text to speech: fill [callback number] from the
 * validated OUTBOUND_CALLBACK_NUMBER (card must allow giving it) and say the
 * name as Owner. A line that needs a callback but has none is not spoken.
 */
export function speakLine(card: ContextCard, key: keyof ContextCard["script"], callbackE164: string | null = null): string {
  let line = card.script[key];
  if (line.includes(CALLBACK_PLACEHOLDER)) {
    if (!callbackE164 || !card.give.includes("callback_number")) return "";
    line = line.replaceAll(CALLBACK_PLACEHOLDER, formatCallback(callbackE164));
  }
  return spokenName(line);
}

/** Display copy (logs, approval card): Owner's spelling, placeholder left as is. */
export function displayLine(card: ContextCard, key: keyof ContextCard["script"]): string {
  return card.script[key];
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';

export function hangupOnlyTwiml(): string {
  return [XML, "<Response>", "  <Hangup/>", "</Response>"].join("\n");
}

export function sayHangupTwiml(text: string): string {
  return [XML, "<Response>", `  <Say>${escapeXml(text)}</Say>`, "  <Hangup/>", "</Response>"].join("\n");
}

/** One listening turn. No Record, Dial, Stream, Play or Redirect verb is ever emitted. */
export function sayGatherTwiml(lines: string[], action: string): string {
  const said = lines.filter(Boolean).map((l) => `    <Say>${escapeXml(l)}</Say>`);
  return [
    XML,
    "<Response>",
    `  <Gather input="speech" language="en-US" speechTimeout="auto" timeout="6" actionOnEmptyResult="true" method="POST" action="${escapeXml(action)}">`,
    ...said,
    "  </Gather>",
    "  <Hangup/>",
    "</Response>",
  ].join("\n");
}

const MACHINE = new Set(["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax"]);

export interface TurnDeps {
  cards: CardStore;
  outcomes: OutcomeStore;
  secret: string | undefined;
  baseUrl: string | undefined;
  now: () => number;
  /** Read at runtime for OUTBOUND_CALLBACK_NUMBER and OUTBOUND_ALLOWLIST; never printed. */
  env: NodeJS.ProcessEnv;
  labeler?: ReplyLabeler;
}

/**
 * Twilio has already been signature-checked by the caller. Every exit path
 * returns TwiML; any doubt (bad state, card mismatch, caps) ends the call.
 */
export async function runTurn(deps: TurnDeps, token: unknown, params: Record<string, string>): Promise<string> {
  const now = deps.now();
  const state = verifyState(token, deps.secret, now);
  const callSid = /^[A-Za-z0-9]{2,64}$/.test(params.CallSid ?? "") ? (params.CallSid as string) : "";
  if (!state || !deps.secret || !deps.baseUrl || !callSid) return hangupOnlyTwiml();

  const prev = deps.outcomes.get(callSid);
  const pinned = deps.cards.loadPinned(state.c, state.h);
  const base: OutcomeRecord = prev ?? {
    callSid,
    approvalId: state.a,
    cardId: state.c,
    cardHash: state.h,
    type: pinned.ok ? pinned.card.type : "unknown",
    calleeName: pinned.ok ? pinned.card.callee.name : "unknown",
    outcome: "unclear",
    item: null,
    pickup: null,
    turns: 0,
    labels: [],
    startedAtMs: null,
    refusal: null,
  };
  if (!pinned.ok) {
    deps.outcomes.put({ ...base, outcome: "card_refused", refusal: pinned.error });
    return hangupOnlyTwiml();
  }
  const card = pinned.card;
  const cb = loadCallbackNumber(deps.env);
  if (!cb.ok) {
    deps.outcomes.put({ ...base, outcome: "card_refused", refusal: cb.reason });
    return hangupOnlyTwiml();
  }
  const say = (key: keyof ContextCard["script"]): string => speakLine(card, key, cb.e164);
  const next = (s: Partial<TurnState>): string =>
    turnUrl(deps.baseUrl as string, { ...state, ...s, e: now + TURN_LINK_TTL_MS }, deps.secret as string);

  // First fetch, when the call is answered.
  if (state.p === "start") {
    if (MACHINE.has(params.AnsweredBy ?? "")) {
      deps.outcomes.put({ ...base, outcome: "voicemail" });
      return hangupOnlyTwiml();
    }
    deps.outcomes.put({ ...base, startedAtMs: now, turns: 1 });
    return sayGatherTwiml([say("opener"), say("aiOffer"), say("question")], next({ p: "ask", n: 1, t: now }));
  }

  const startedAt = state.t > 0 ? state.t : now;
  const label = await classifyReply(card, params.SpeechResult ?? "", deps.labeler);
  const rec: OutcomeRecord = { ...base, labels: [...base.labels, label] };
  const close = (outcome: Outcome, extra: Partial<OutcomeRecord> = {}): string => {
    deps.outcomes.put({ ...rec, ...extra, outcome });
    return sayHangupTwiml(say("close"));
  };

  if (label === "OFFTOPIC") {
    deps.outcomes.put({ ...rec, outcome: rec.outcome === "yes" ? "yes" : "refused", refusal: "off_card" });
    return sayHangupTwiml(say("refuse"));
  }
  if (label === "DECLINE") {
    deps.outcomes.put({ ...rec, outcome: "declined" });
    return sayHangupTwiml(say("decline"));
  }

  const takeItem = card.take.includes("item_type");
  const takePickup = card.take.includes("pickup_timing");
  const speech = params.SpeechResult ?? "";
  const item = takeItem ? (extractItem(speech) ?? rec.item) : null;
  const pickup = takePickup ? (extractPickup(speech) ?? rec.pickup) : null;
  const outOfTime = now - startedAt >= card.end.maxSeconds * 1000;
  const canGather = state.n < card.end.maxTurns && !outOfTime;

  if (state.p === "follow") {
    return close("yes", { item, pickup });
  }
  // Phase "ask".
  if (label === "NO") return close("no");
  if (label === "YES") {
    const needMore = (takeItem && !item) || (takePickup && !pickup);
    if (needMore && canGather) {
      deps.outcomes.put({ ...rec, outcome: "yes", item, pickup, turns: state.n + 1 });
      return sayGatherTwiml([say("followUp")], next({ p: "follow", n: state.n + 1 }));
    }
    return close("yes", { item, pickup });
  }
  // UNCLEAR or silence: repeat once, then close.
  if (state.r < 1 && canGather) {
    deps.outcomes.put({ ...rec, turns: state.n + 1 });
    return sayGatherTwiml([say("repeat")], next({ n: state.n + 1, r: state.r + 1 }));
  }
  return close("unclear");
}
