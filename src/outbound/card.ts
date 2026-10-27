import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateUsDialNumber } from "./number.js";
import { carriesDonorPitch } from "./opener.js";

/**
 * Outbound context card. Every outbound call needs one before it can be
 * approved. Everything the call may say comes from card.script; nothing
 * else is spoken. Cards hold no phone numbers: callee.numberRef names a key
 * in the volume-only numbers map (call-cards/numbers.json, never in git).
 */
export const CARD_TYPES = ["business"] as const;
export const GIVE_VALUES = ["callback_number"] as const;
export const TAKE_VALUES = ["returns_answer", "item_type", "pickup_timing"] as const;
export const CALLEE_KINDS = ["business_landline"] as const;
export const SCRIPT_KEYS = ["opener", "aiOffer", "question", "followUp", "repeat", "refuse", "decline", "close"] as const;
export const MAX_CARD_TURNS = 3;
/** The only placeholder a script line may carry. Filled from OUTBOUND_CALLBACK_NUMBER at call time. */
export const CALLBACK_PLACEHOLDER = "[callback number]";
/** Owner's approved opener (display spelling). Spoken with the name as Owner. */
export const APPROVED_OPENER =
  "Hi, this is Owner's AI bot, calling for Example Business to see if you have any returns for us. You can reach us at [callback number].";
export const MAX_CARD_SECONDS = 90;

export type CardType = (typeof CARD_TYPES)[number];
export type GiveValue = (typeof GIVE_VALUES)[number];
export type TakeValue = (typeof TAKE_VALUES)[number];
export type ScriptKey = (typeof SCRIPT_KEYS)[number];

export interface ContextCard {
  id: string;
  version: number;
  type: CardType;
  callee: { name: string; kind: (typeof CALLEE_KINDS)[number]; numberRef: string };
  why: string;
  goal: string;
  script: Record<ScriptKey, string>;
  allowedTopics: string[];
  give: GiveValue[];
  take: TakeValue[];
  end: { maxTurns: number; maxSeconds: number; onVoicemail: "hangup_silent"; onNoAnswer: "hangup" };
  recording: false;
}

export type CardResult = { ok: true; card: ContextCard; hash: string } | { ok: false; error: string };

const TOP_KEYS = ["id", "version", "type", "callee", "why", "goal", "script", "allowedTopics", "give", "take", "end", "recording"];
const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;
const ID_RE = /^[a-z0-9-]{3,64}$/;
const REF_RE = /^[A-Z0-9_]{2,40}$/;
/** No phone number can hide in card text: any run of 7+ digits (spaces, dots, dashes between) fails. */
const DIGIT_RUN = /\d(?:[\s().-]*\d){6,}/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k));
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || t.length > max || t !== v) return null;
  if (CONTROL.test(t) || DIGIT_RUN.test(t) || carriesDonorPitch(t)) return null;
  return t;
}

function enumList<T extends string>(v: unknown, allowed: readonly T[]): T[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > allowed.length) return null;
  const out: T[] = [];
  for (const item of v) {
    if (typeof item !== "string" || !allowed.includes(item as T) || out.includes(item as T)) return null;
    out.push(item as T);
  }
  return out;
}

/** Strict validation. Unknown keys, recording on, or caps above 3 turns / 90 s are rejected. */
export function validateCard(value: unknown): CardResult {
  if (!isObj(value)) return { ok: false, error: "not_object" };
  if (!onlyKeys(value, TOP_KEYS)) return { ok: false, error: "unknown_key" };
  if (typeof value.id !== "string" || !ID_RE.test(value.id)) return { ok: false, error: "bad_id" };
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return { ok: false, error: "bad_version" };
  if (!CARD_TYPES.includes(value.type as CardType)) return { ok: false, error: "bad_type" };
  if (value.recording !== false) return { ok: false, error: "recording_must_be_false" };

  const callee = value.callee;
  if (!isObj(callee) || !onlyKeys(callee, ["name", "kind", "numberRef"])) return { ok: false, error: "bad_callee" };
  const name = text(callee.name, 80);
  if (!name) return { ok: false, error: "bad_callee" };
  if (!CALLEE_KINDS.includes(callee.kind as "business_landline")) return { ok: false, error: "bad_callee" };
  if (typeof callee.numberRef !== "string" || !REF_RE.test(callee.numberRef)) return { ok: false, error: "bad_number_ref" };

  const why = text(value.why, 200);
  const goal = text(value.goal, 200);
  if (!why || !goal) return { ok: false, error: "bad_why_goal" };

  const script = value.script;
  if (!isObj(script) || !onlyKeys(script, SCRIPT_KEYS)) return { ok: false, error: "bad_script" };
  const lines = {} as Record<ScriptKey, string>;
  for (const key of SCRIPT_KEYS) {
    const line = text(script[key], 200);
    if (!line) return { ok: false, error: `bad_script_${key}` };
    lines[key] = line;
  }
  // FCC 24-17: the AI disclosure stays in the opener.
  if (!/\bAI\b/.test(lines.opener)) return { ok: false, error: "opener_needs_ai_disclosure" };

  const give = enumList(value.give, GIVE_VALUES);
  const take = enumList(value.take, TAKE_VALUES);
  if (!give) return { ok: false, error: "bad_give" };
  if (!take) return { ok: false, error: "bad_take" };
  // The callback placeholder may only be spoken when the card allows giving it.
  const usesCallback = SCRIPT_KEYS.some((k) => lines[k].includes(CALLBACK_PLACEHOLDER));
  if (usesCallback && !give.includes("callback_number")) return { ok: false, error: "callback_not_in_give" };
  if (SCRIPT_KEYS.some((k) => /[{}]/.test(lines[k]) || /[[\]]/.test(lines[k].replaceAll(CALLBACK_PLACEHOLDER, "")))) {
    return { ok: false, error: "bad_placeholder" };
  }
  // The AI hang-up offer must actually offer to hang up.
  if (!/\bAI\b/.test(lines.aiOffer) || !/hang up/i.test(lines.aiOffer)) return { ok: false, error: "bad_ai_offer" };

  if (!Array.isArray(value.allowedTopics) || value.allowedTopics.length !== 1 || value.allowedTopics[0] !== "example_returns") {
    return { ok: false, error: "bad_topics" };
  }

  const end = value.end;
  if (!isObj(end) || !onlyKeys(end, ["maxTurns", "maxSeconds", "onVoicemail", "onNoAnswer"])) return { ok: false, error: "bad_end" };
  const maxTurns = end.maxTurns;
  const maxSeconds = end.maxSeconds;
  if (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < 1 || (maxTurns as number) > MAX_CARD_TURNS) {
    return { ok: false, error: "bad_max_turns" };
  }
  if (!Number.isSafeInteger(maxSeconds) || (maxSeconds as number) < 15 || (maxSeconds as number) > MAX_CARD_SECONDS) {
    return { ok: false, error: "bad_max_seconds" };
  }
  if (end.onVoicemail !== "hangup_silent" || end.onNoAnswer !== "hangup") return { ok: false, error: "bad_end" };

  const card: ContextCard = {
    id: value.id,
    version: value.version as number,
    type: value.type as CardType,
    callee: { name, kind: "business_landline", numberRef: callee.numberRef },
    why,
    goal,
    script: lines,
    allowedTopics: ["example_returns"],
    give,
    take,
    end: { maxTurns: maxTurns as number, maxSeconds: maxSeconds as number, onVoicemail: "hangup_silent", onNoAnswer: "hangup" },
    recording: false,
  };
  return { ok: true, card, hash: cardHash(value) };
}

/** Sorted keys, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex of the canonical JSON of the raw card file. */
export function cardHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function isCardHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Reads cards from <dataDir>/call-cards on the Fly volume. Read-only: this
 * module has no write path. Each load re-reads the file, so an edit after
 * approval changes the hash and the dial/turn checks refuse.
 */
export class CardStore {
  constructor(private readonly dir: string) {}

  static forDataDir(dataDir: string): CardStore {
    return new CardStore(path.join(dataDir, "call-cards"));
  }

  load(id: unknown): CardResult {
    if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, error: "card_missing" };
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8");
    } catch {
      return { ok: false, error: "card_missing" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: "card_invalid" };
    }
    const checked = validateCard(parsed);
    if (!checked.ok) return { ok: false, error: "card_invalid" };
    if (checked.card.id !== id) return { ok: false, error: "card_invalid" };
    return checked;
  }

  /** Load and require the exact approved hash. */
  loadPinned(id: unknown, hash: unknown): CardResult {
    if (!isCardHash(hash)) return { ok: false, error: "card_hash_mismatch" };
    const loaded = this.load(id);
    if (!loaded.ok) return loaded;
    if (!timingEqualHex(loaded.hash, hash)) return { ok: false, error: "card_hash_mismatch" };
    return loaded;
  }

  /** E.164 for a numberRef from call-cards/numbers.json (volume only). Null if absent or invalid. */
  resolveNumber(ref: string): string | null {
    try {
      const map: unknown = JSON.parse(fs.readFileSync(path.join(this.dir, "numbers.json"), "utf8"));
      if (!isObj(map) || typeof map[ref] !== "string") return null;
      const check = validateUsDialNumber(map[ref] as string);
      return check.ok ? check.e164 : null;
    } catch {
      return null;
    }
  }
}

function timingEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
