import crypto from "node:crypto";

import { FALLBACK_VOICE } from "../config.js";
import { looksLikeInjection } from "../injection.js";
import { logInfo } from "../logger.js";
import { looksLikeSales, mentionsMoney, scamPhrases } from "../money.js";
import { normalizeSpeech } from "../normalize.js";
import { greetingDiverged, greetingPrefixReady, screenAssistant } from "../guardrail.js";
import { DONOR_X_MONEY, PERSONAL_DETAIL_REFUSAL, URGENT_NOTICE, allowAnsweredQuestion } from "../prompt.js";
import {
  foldDigitRuns,
  hasSensitiveNumber,
  redactFallbackExcerpt,
  redactNullablePhone,
  redactNullableText,
  redactSensitiveDigits,
  redactStoredSummary,
  trimPartialDigitRun,
  validatedPhone,
} from "../redact.js";
import { MAX_SUMMARY_QUESTIONS, buildTranscriptSummary, normalizeFlags, normalizeQuestions } from "../summary/payload.js";
import type { CallFlag, CallLogEntry, CallQuestion, MessageFields } from "../types.js";
import { emptyMessage } from "../types.js";
import {
  GREETING,
  buildForceMessage,
  buildFunctionOutput,
  buildGreetingItem,
  buildResponseCreate,
  buildSessionUpdate,
  canonicalizeOwner,
  spokenGreeting,
} from "./protocol.js";

export interface TranscriptLine {
  role: "caller" | "assistant";
  text: string;
}

interface PendingMedia {
  key: string;
  payload: string;
}

interface HeldResponseAudio {
  chunks: string[];
  blocked: boolean;
  /** The full transcript passed. Later audio for this response may go to Twilio. */
  passed: boolean;
  /** Text that passed. A later append is checked again before more audio goes out. */
  passedText: string;
  /** Clock reading when the full text passed, and when the first frame was sent. */
  textDoneAtMs: number | null;
  firstMediaAtMs: number | null;
}

const HELD_AUDIO_CAP = 500;

interface FlagSource {
  text: string;
  injection: boolean;
  phoneField?: boolean;
}

interface PendingUtterance {
  key: string;
  role: "caller" | "assistant";
  text: string;
  ready: boolean;
  /** Caller item id, so a committed segment can drop its provisional text. */
  itemId?: string;
  /**
   * Set when an empty .completed sealed a partial. A later transcript for this
   * key replaces that partial, including a correction that does not extend it.
   */
  sealedEmpty?: boolean;
}

/**
 * How many open utterances stay in the ordering queue. Past this, newer ones
 * wait in overflow and are still updated. Nothing is sealed early.
 */
const OPEN_UTTERANCE_CAP = 100;
/** Open utterances held behind the ordering queue. Older ones are dropped past this. */
const OVERFLOW_CAP = 500;
/** Provisional caller strings. The queue is the real bound; this is a backstop. */
const PROVISIONAL_CAP = 600;
/** Completed ids remembered so a replay does not append a second line. */
const PLACED_LIMIT = 128;
/** Raw flag texts. Flags themselves stay after a source is dropped. */
const FLAG_SOURCE_LIMIT = 200;

export interface MachineState {
  id: string;
  streamSid: string | null;
  callSid: string | null;
  callerNumber: string | null;
  startedAtMs: number;
  xaiReady: boolean;
  greeted: boolean;
  greetingOpen: boolean;
  sessionUpdateSent: boolean;
  awaitingVoiceFallback: boolean;
  activeVoice: string;
  activeResponseId: string | null;
  suppressedResponseId: string | null;
  suppressUnscopedAudio: boolean;
  pronunciation: boolean;
  /** Catalog spelling, with Owner. The force_message applies the Owner replace. */
  greeting: string;
  /** Stored display name for this caller-ID match. Not a relation. */
  knownName: string | null;
  /** True when a completed caller transcript still asks to give. Partials do not set it. */
  callerAskedToGive: boolean;
  instructions: string;
  pendingAudio: string[];
  /** Approved assistant audio waiting for streamSid. Unchecked audio never lands here. */
  pendingTwilioAudio: PendingMedia[];
  /** Per-response audio held until that response's full transcript passes the guardrail. */
  heldAudio: Record<string, HeldResponseAudio>;
  /** Response that is speaking the fixed greeting. Other responses stay held. */
  greetingResponseId: string | null;
  /** Test clock. Production uses Date.now. The hold is the difference of two readings. */
  nowMs: () => number;
  /** One scripted refusal per tripped response. */
  refusalSent: Record<string, true>;
  assistantByResponse: Record<string, string>;
  /** transcript.done has sealed this response. A later delta is still guarded. */
  assistantDone: Record<string, true>;
  /** Text sealed by transcript.done, including a post-done delta appended to it. */
  assistantFinal: Record<string, string>;
  provisionalCaller: Record<string, string>;
  /** First-seen order. A line stays here until every utterance ahead of it is final. */
  pendingUtterances: PendingUtterance[];
  /** Newer open utterances once the ordering queue is full. Stored in order at call end if still open. */
  overflowUtterances: PendingUtterance[];
  /** Keys already written. Bounded so a long call cannot grow without limit. */
  placedKeys: Record<string, true>;
  placedOrder: string[];
  /** Transcript line written for a key, so a later snapshot can replace it. */
  placedLines: Record<string, TranscriptLine>;
  /** Pre-redaction caller text for a placed key. Extension checks use this, not the redacted line. */
  placedRaw: Record<string, string>;
  /**
   * Key whose stored line came from an empty .completed. The next real
   * transcript replaces it. A non-empty .completed clears the flag.
   */
  placedOpen: Record<string, true>;
  /** Caller item id for a placed key. Segments of one item can share a line. */
  placedItem: Record<string, string>;
  /** Distinguishes assistant transcripts that arrive without a response id. */
  assistantEpoch: number;
  /** Response keys whose later audio is dropped after the guardrail trips. */
  guardedIds: Record<string, true>;
  /** One Twilio clear per guarded response. */
  guardCleared: Record<string, true>;
  transcript: TranscriptLine[];
  message: MessageFields;
  /** Raw message fields, so a later transcript revision can recompute flags. */
  messageSource: MessageFields;
  /** True after record_message accepts at least one field. */
  messageRecorded: boolean;
  /** Model asked to flag the call. Cleared when a scam or a sales pitch is present. */
  urgentAsk: boolean;
  /** Raw urgent_reason, scanned for scam and money. It is not copied into the summary. */
  urgentReasonSource: string | null;
  /** Caller questions, already redacted, in the order they were asked. */
  questions: CallQuestion[];
  /** Pre-redaction question text, parallel to questions, for flag scans. */
  questionRaw: string[];
  /** Approved fact topics for this call. Answers are not copied here. */
  approvedTopics: string[];
  /** Latched. A sales pitch is never urgent, and a later revision does not clear it. */
  salesPitch: boolean;
  /**
   * Pre-redaction text for flags still being scanned. A newer snapshot replaces
   * the text. money_related and possible_scam already raised stay until the
   * call ends. Other flags already raised stay; dropping a source does not
   * clear them.
   */
  flagSources: Record<string, FlagSource>;
  /** Oldest first. Keeps flagSources from growing for the whole call. */
  flagSourceOrder: string[];
  lineSeq: number;
  flags: CallFlag[];
  handledCallIds: string[];
  voiceFallbackUsed: boolean;
  ended: boolean;
}

export interface Outbound {
  to: "twilio" | "xai";
  payload: unknown;
}

export interface Step {
  state: MachineState;
  outbound: Outbound[];
  log?: { level: "info" | "warn"; message: string };
  fatal?: boolean;
}

export function createState(input: {
  id?: string;
  callSid: string | null;
  callerNumber: string | null;
  startedAtMs: number;
  voice: string;
  pronunciation: boolean;
  instructions: string;
  flags: readonly string[];
  greeting?: string;
  knownName?: string | null;
  approvedTopics?: readonly string[];
  nowMs?: () => number;
}): MachineState {
  return {
    id: input.id ?? crypto.randomUUID(),
    streamSid: null,
    callSid: input.callSid,
    callerNumber: input.callerNumber,
    startedAtMs: input.startedAtMs,
    xaiReady: false,
    greeted: false,
    greetingOpen: false,
    sessionUpdateSent: false,
    awaitingVoiceFallback: false,
    activeVoice: input.voice,
    activeResponseId: null,
    suppressedResponseId: null,
    suppressUnscopedAudio: false,
    pronunciation: input.pronunciation,
    greeting: input.greeting ?? GREETING,
    knownName: input.knownName ?? null,
    callerAskedToGive: false,
    instructions: input.instructions,
    pendingAudio: [],
    pendingTwilioAudio: [],
    heldAudio: {},
    greetingResponseId: null,
    nowMs: input.nowMs ?? Date.now,
    refusalSent: {},
    assistantByResponse: {},
    assistantDone: {},
    assistantFinal: {},
    provisionalCaller: {},
    pendingUtterances: [],
    overflowUtterances: [],
    placedKeys: {},
    placedOrder: [],
    placedLines: {},
    placedRaw: {},
    placedOpen: {},
    placedItem: {},
    assistantEpoch: 0,
    guardedIds: {},
    guardCleared: {},
    transcript: [],
    message: emptyMessage(),
    messageSource: emptyMessage(),
    messageRecorded: false,
    urgentAsk: false,
    urgentReasonSource: null,
    questions: [],
    questionRaw: [],
    approvedTopics: [...(input.approvedTopics ?? [])],
    salesPitch: false,
    flagSources: {},
    flagSourceOrder: [],
    lineSeq: 0,
    flags: normalizeFlags(input.flags),
    handledCallIds: [],
    voiceFallbackUsed: false,
    ended: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clip(value: string, max = 180): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

function cleanField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, 500);
}

function addFlag(state: MachineState, flag: CallFlag): void {
  if (!state.flags.includes(flag)) state.flags.push(flag);
}

/**
 * The exact donor sentence, Owner or Owner, is not money talk. Any other
 * sentence in the same line still is. Flag text is already canonicalized;
 * both spellings are kept so a source that skipped that step still matches.
 */
const DONOR_SENTENCE_KEYS: ReadonlySet<string> = new Set(
  [DONOR_X_MONEY, spokenGreeting(true, DONOR_X_MONEY)].flatMap((variant) => {
    const keys: string[] = [];
    for (const value of [variant, canonicalizeOwner(variant)]) {
      const speech = normalizeSpeech(value);
      if (speech.sentences.length === 1 && speech.text) keys.push(speech.text);
    }
    return keys;
  }),
);

function withoutExactDonorSentences(text: string): string {
  const speech = normalizeSpeech(canonicalizeOwner(text));
  if (!speech.sentences.some((sentence) => DONOR_SENTENCE_KEYS.has(sentence.join(" ")))) return text;
  const kept = speech.sentences.filter((sentence) => !DONOR_SENTENCE_KEYS.has(sentence.join(" ")));
  return kept.map((sentence) => sentence.join(" ")).join(". ");
}

/**
 * Five words, one more than the cash pattern allows between a verb and cash.
 * The skeleton drops punctuation, so a sentence break has to stay as words or
 * "gave Mom the news. Cash" is read as gave cash. "He gave. Cash now." is the
 * exception: the verb is the last word and cash is the next, so no gap is
 * inserted. These replacements are for summary flags only. The answer
 * guardrail still sees card, bank, routing, wire, and pay.
 */
const SENTENCE_GAP = "gap gap gap gap gap";

const MONEY_VERB_END =
  /\b(?:sends?|sending|sent|pays?|paying|paid|gives?|giving|gave|given|wires?|wiring|wired|owes?|owing|owed)$/i;

function endsWithMoneyVerb(before: string): boolean {
  return MONEY_VERB_END.test(before.trimEnd());
}

/** The sentence that contains index. Breaks are . ! ? ; */
function sentenceAt(text: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? "";
    if (ch === "." || ch === "!" || ch === "?" || ch === ";") {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === "." || ch === "!" || ch === "?" || ch === ";") {
      end = i;
      break;
    }
  }
  return text.slice(start, end);
}

function withSentenceGaps(text: string): string {
  return text.replace(/([.!?;])(\s+)/g, (match, punct: string, space: string, offset: number) => {
    const before = text.slice(0, offset);
    const after = text.slice(offset + match.length);
    // "He gave. Cash now." stays adjacent. "gave Mom the news. Cash" still gaps.
    if (endsWithMoneyVerb(before) && /^cash\b/i.test(after)) return match;
    return `${punct}${space}${SENTENCE_GAP} `;
  });
}

/**
 * Homonym replacements for summary flags. A real money word in the same
 * sentence is left in place: "live wire transfer" keeps wire, and "pay you a
 * visit" keeps pay when that sentence also says cash, so cash is scored with
 * the money verb still present.
 */
function maskMoneyHomonyms(text: string): string {
  const gapped = withSentenceGaps(text);
  return gapped
    .replace(/\b(?:a|an)[\s-]+bucks?\b/gi, "a deer")
    .replace(/\b2[\s-]+cents?\b/gi, "two cents")
    .replace(/\b50[\s-]+cent\b(?!s)/gi, "a performer")
    .replace(/\bpay(?:s|ing)?\s+(?:you|him|her|them|us|me)\s+a\s+visit\b/gi, (match, offset: number, whole: string) => {
      if (/\bcash\b/i.test(sentenceAt(whole, offset))) return match;
      return "stop by";
    })
    .replace(/\briver\s+banks?\b/gi, "river shore")
    .replace(/\blive\s+wires?\b(?!\s+(?:transfers?|payments?|money|cash|dollars?|funds?|fees?|deposits?|amounts?|bucks?|cents?|bitcoins?|invoices?|refunds?|loans?|donations?)\b)/gi, "live cable")
    .replace(/\bcall\s+routing\b(?!\s*(?:numbers?|no\.?|#|\d))/gi, "call path");
}

/**
 * "I am not donating.", "I didn't donate.", and "This is not a donation." are
 * not money talk. The donate word is hidden only when a negation is a few
 * words in front of it. A later "Send cash." in the same line still counts.
 */
function maskNegatedGiving(text: string): string {
  const negation =
    "not|don't|dont|don\u2019t|do not|never|won't|wont|won\u2019t|will not|haven't|havent|haven\u2019t|have not|didn't|didnt|didn\u2019t|did not|can't|cant|can\u2019t|cannot|can not";
  const giving = "donat(?:e|es|ed|ion|ions|ing)";
  const re = new RegExp(`\\b(?:${negation})\\b(?:\\s+\\w+){0,3}\\s+${giving}\\b`, "gi");
  return text.replace(re, (match) => match.replace(/donat(?:e|es|ed|ion|ions|ing)/gi, "offering"));
}

function textForContentFlags(text: string): string {
  return maskNegatedGiving(maskMoneyHomonyms(withoutExactDonorSentences(text)));
}

/**
 * money_related and possible_scam are only added. Once either is raised it
 * stays until the call ends, including when a later correction removes the
 * money text. A line that never raised one still does not. urgent is removed
 * while possible_scam or a sales pitch is present, and a possible scam wins.
 * Other flags, including injection_attempt, stay. Money scoring skips the
 * exact donor sentence, negated giving phrases, and money-word homonyms.
 * Digits, injection, and sales still use the original text.
 */
function recomputeContentFlags(state: MachineState): void {
  const next: CallFlag[] = state.flags.filter(
    (flag) => flag !== "urgent" && flag !== "money_related" && flag !== "possible_scam",
  );
  const add = (flag: CallFlag): void => {
    if (flag === "urgent" || flag === "money_related" || flag === "possible_scam") return;
    if (!next.includes(flag)) next.push(flag);
  };
  // Raised money and scam flags stay for this call. The next call starts clean.
  let moneyRelated = state.flags.includes("money_related");
  let possibleScam = state.flags.includes("possible_scam") || moneyRelated;
  for (const source of Object.values(state.flagSources)) {
    if (!source.text) continue;
    if (source.injection && looksLikeInjection(source.text)) add("injection_attempt");
    const scored = textForContentFlags(source.text);
    const money = mentionsMoney(scored);
    if (money) moneyRelated = true;
    const keptPhone = source.phoneField === true && validatedPhone(source.text) === source.text;
    const digits = keptPhone ? false : hasSensitiveNumber(source.text);
    // Owner's rule: any money talk is also a possible scam.
    if (money || scamPhrases(scored) || digits) possibleScam = true;
    if (looksLikeSales(source.text)) state.salesPitch = true;
  }
  if (moneyRelated) next.push("money_related");
  if (possibleScam) next.push("possible_scam");
  if (state.urgentAsk && !possibleScam && !state.salesPitch) next.push("urgent");
  state.flags = next;
}

function forgetFlagSource(state: MachineState, id: string): void {
  delete state.flagSources[id];
  const index = state.flagSourceOrder.indexOf(id);
  if (index >= 0) state.flagSourceOrder.splice(index, 1);
}

function setFlagSource(
  state: MachineState,
  id: string,
  text: string,
  opts: { injection: boolean; phoneField?: boolean },
): void {
  const canon = canonicalizeOwner(text).trim().slice(0, 2000);
  if (!canon) {
    forgetFlagSource(state, id);
  } else {
    state.flagSources[id] = { text: canon, injection: opts.injection, phoneField: opts.phoneField };
    const index = state.flagSourceOrder.indexOf(id);
    if (index >= 0) state.flagSourceOrder.splice(index, 1);
    state.flagSourceOrder.push(id);
    while (state.flagSourceOrder.length > FLAG_SOURCE_LIMIT) {
      const old = state.flagSourceOrder.shift();
      if (old) delete state.flagSources[old];
    }
  }
  recomputeContentFlags(state);
}

function syncMessageFlags(state: MachineState): void {
  const source = state.messageSource;
  setFlagSource(state, "msg:name", source.name ?? "", { injection: true });
  setFlagSource(state, "msg:callback", source.callback_number ?? "", { injection: true, phoneField: true });
  setFlagSource(state, "msg:reason", source.reason ?? "", { injection: true });
  setFlagSource(state, "msg:urgent_reason", state.urgentReasonSource ?? "", { injection: true });
}

function pushLine(
  state: MachineState,
  role: "caller" | "assistant",
  text: string,
  flagId?: string,
  allowDuplicate = false,
): TranscriptLine | undefined {
  const canon = canonicalizeOwner(text).trim();
  if (!canon) return;
  const clipped = (role === "caller" ? preparedCaller(canon) : redactSensitiveDigits(canon).slice(0, 2000));
  if (!clipped) return;
  setFlagSource(state, flagId ?? `${role}:${state.lineSeq++}`, canon, { injection: role === "caller" });
  const last = state.transcript[state.transcript.length - 1];
  if (!allowDuplicate && last && last.role === role && last.text === clipped) return;
  const line: TranscriptLine = { role, text: clipped };
  state.transcript.push(line);
  if (state.transcript.length > 100) state.transcript.shift();
  return line;
}

/** One caller line per item and content part. Later snapshots update that line. */
function callerStorageKey(itemId: string, contentIndex: number): string {
  return `c:${itemId}:${contentIndex}`;
}

function assistantPendingKey(key: string): string {
  return `a:${key}`;
}

function contentIndexOf(record: Record<string, unknown>): number {
  const value = record.content_index;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1000) return value;
  if (typeof value === "string" && /^\d{1,3}$/.test(value)) return Number(value);
  return 0;
}

function debugXaiEvents(): boolean {
  const value = process.env.DEBUG_XAI_EVENTS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function fieldText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Event types are dotted tokens. Anything else is not safe to log. */
function debugType(value: string): string {
  return /^[a-z][a-z0-9_.]{0,79}$/.test(value) ? value : "invalid";
}

/** Ids are opaque tokens. Sentences, audio, and other free text are not. */
function debugId(value: string): string {
  if (!value) return "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) return "invalid";
  if (/[A-Za-z]{20,}/.test(value)) return "invalid";
  // A card, bank, or phone number is not an id, even with dashes.
  if (value.replace(/\D/g, "").length >= 8) return "invalid";
  return value;
}

function debugContentIndex(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1000) return String(value);
  if (typeof value === "string" && /^\d{1,3}$/.test(value)) return value;
  return "";
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/** Metadata only. Transcript text, audio, and free-form fields are never interpolated. */
function debugXaiEvent(record: Record<string, unknown>): void {
  if (!debugXaiEvents()) return;
  let responseId = fieldText(record.response_id);
  if (!responseId) {
    const response = asRecord(record.response);
    responseId = fieldText(response?.id);
  }
  const textLen = Math.max(textLength(record.transcript), textLength(record.delta), textLength(record.text));
  logInfo(
    `xAI event type=${debugType(fieldText(record.type))} item_id=${debugId(fieldText(record.item_id))} response_id=${debugId(responseId)} content_index=${debugContentIndex(record.content_index)} text_len=${textLen}`,
  );
}

function responseKey(state: MachineState, event: Record<string, unknown>): string {
  return str(event.response_id) ?? str(event.item_id) ?? `assistant:${state.assistantEpoch}`;
}

/** Blank is not a final transcript. Callers fall back to the last cumulative update. */
function eventTranscript(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function rememberPlaced(state: MachineState, key: string): void {
  if (state.placedKeys[key]) return;
  state.placedKeys[key] = true;
  state.placedOrder.push(key);
  while (state.placedOrder.length > PLACED_LIMIT) {
    const old = state.placedOrder.shift();
    if (!old) continue;
    delete state.placedKeys[old];
    delete state.placedLines[old];
    delete state.placedRaw[old];
    delete state.placedOpen[old];
    delete state.placedItem[old];
  }
}

function findUtterance(state: MachineState, key: string): PendingUtterance | undefined {
  return (
    state.pendingUtterances.find((item) => item.key === key) ??
    state.overflowUtterances.find((item) => item.key === key)
  );
}

function enqueueUtterance(state: MachineState, slot: PendingUtterance): void {
  // Once overflow holds newer items, keep appending there so a free slot in
  // the ordering queue cannot jump ahead of them.
  if (state.overflowUtterances.length === 0 && state.pendingUtterances.length < OPEN_UTTERANCE_CAP) {
    state.pendingUtterances.push(slot);
    return;
  }
  state.overflowUtterances.push(slot);
  while (state.overflowUtterances.length > OVERFLOW_CAP) {
    const dropped = state.overflowUtterances.shift();
    if (!dropped) break;
    forgetFlagSource(state, dropped.key);
    const itemId = dropped.itemId;
    if (!itemId) continue;
    const still =
      state.pendingUtterances.some((item) => item.itemId === itemId) ||
      state.overflowUtterances.some((item) => item.itemId === itemId);
    if (!still) delete state.provisionalCaller[itemId];
  }
}

function rememberProvisional(state: MachineState, itemId: string, shown: string): void {
  if (Object.prototype.hasOwnProperty.call(state.provisionalCaller, itemId)) {
    delete state.provisionalCaller[itemId];
  }
  state.provisionalCaller[itemId] = shown;
  const ids = Object.keys(state.provisionalCaller);
  while (ids.length > PROVISIONAL_CAP) {
    const oldest = ids.shift();
    if (oldest) delete state.provisionalCaller[oldest];
  }
}

function refillPending(state: MachineState): void {
  if (state.pendingUtterances.length > 0) return;
  while (state.pendingUtterances.length < OPEN_UTTERANCE_CAP && state.overflowUtterances.length > 0) {
    const next = state.overflowUtterances.shift();
    if (next) state.pendingUtterances.push(next);
  }
}

function preparedCaller(text: string): string {
  return redactCallerLine(canonicalizeOwner(text).trim()).slice(0, 2000);
}

/** Caller lines keep phones, short counts, clocks, and years. Every other digit run goes. */
function redactCallerLine(text: string): string {
  return redactSensitiveDigits(text);
}

/** Compare caller extensions after pronunciation, case, and whitespace are folded. */
function normalizeForExtend(text: string): string {
  return canonicalizeOwner(text)
    .toLowerCase()
    .replaceAll("owner's", "owner's")
    .replaceAll("owner", "owner")
    .replace(/\s+/g, " ")
    .trim();
}

/** Punctuation changes must not hide that a later snapshot is an older prefix. */
function foldSnapshot(text: string): string {
  return normalizeForExtend(text)
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameUtterance(previous: string, next: string): boolean {
  const left = foldSnapshot(previous);
  const right = foldSnapshot(next);
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

type SnapshotRelation = "stale" | "same" | "extends" | "other";

function judgeSnapshot(kept: string, next: string): SnapshotRelation {
  if (!kept || !next) return "other";
  if (kept === next) return "same";
  if (next.length < kept.length && kept.startsWith(next)) return "stale";
  if (next.length > kept.length && next.startsWith(kept)) return "extends";
  return "other";
}

/**
 * One comparison for every same-item snapshot, on any content index and any
 * event. Shown text is compared after redaction. Digit folding uses the same
 * normalization as the allowlist, so a shorter unredacted line cannot replace
 * a redacted one.
 */
function sameItemRelation(keptRaw: string, nextRaw: string): SnapshotRelation {
  const keptShown = redactCallerLine(keptRaw);
  const nextShown = redactCallerLine(nextRaw);
  const shown = judgeSnapshot(foldSnapshot(keptShown), foldSnapshot(nextShown));
  if (shown === "stale" || shown === "same" || shown === "extends") return shown;
  const digits = judgeSnapshot(foldDigitRuns(keptRaw), foldDigitRuns(nextRaw));
  if (digits === "stale" || digits === "same") return digits;
  return shown;
}

/** A callback is a validated phone, or the validated Twilio caller number, or null. */
function storedPhone(candidate: string | null, callerNumber: string | null): string | null {
  return validatedPhone(candidate) ?? validatedPhone(callerNumber);
}

/** A later snapshot for this key replaces the stored line. It does not add a second line. */
function applyCallerText(
  state: MachineState,
  key: string,
  itemId: string,
  text: string,
  forceReplace = false,
): void {
  const canon = canonicalizeOwner(text).trim();
  if (!canon) return;
  const clipped = preparedCaller(canon);
  if (!clipped) return;

  const own = state.placedLines[key];
  if (own) {
    const previous = state.placedRaw[key] ?? "";
    const relation = previous ? sameItemRelation(previous, canon) : "other";
    // A late .updated or repeated .completed can replay an older prefix.
    // Replacing the line with it would also put a short card prefix back in the clear.
    if (relation === "same" || relation === "stale") {
      if (relation === "stale" && previous) setFlagSource(state, key, previous, { injection: true });
      if (previous) dropPrefixProvisional(state, itemId, previous);
      return;
    }
    if (!forceReplace && relation !== "extends") return;
    own.text = clipped;
    for (const [otherKey, otherLine] of Object.entries(state.placedLines)) {
      if (otherLine === own) state.placedRaw[otherKey] = canon;
    }
    state.placedRaw[key] = canon;
    setFlagSource(state, key, canon, { injection: true });
    return;
  }

  if (itemId) {
    for (const [otherKey, line] of Object.entries(state.placedLines)) {
      if (state.placedItem[otherKey] !== itemId || line.role !== "caller") continue;
      const otherRaw = state.placedRaw[otherKey] ?? line.text;
      const relation = sameItemRelation(otherRaw, canon);
      if (relation === "stale" || relation === "same") {
        state.placedLines[key] = line;
        state.placedRaw[key] = state.placedRaw[otherKey] ?? otherRaw;
        state.placedItem[key] = itemId;
        dropPrefixProvisional(state, itemId, otherRaw);
        return;
      }
      if (relation === "extends") {
        line.text = clipped;
        state.placedRaw[otherKey] = canon;
        state.placedLines[key] = line;
        state.placedRaw[key] = canon;
        state.placedItem[key] = itemId;
        setFlagSource(state, otherKey, canon, { injection: true });
        setFlagSource(state, key, canon, { injection: true });
        return;
      }
    }
  }

  // A different item that happens to share this wording still gets its own line.
  // Sharing the object let a later snapshot rewrite the earlier utterance.
  // Link the line we just pushed. At the 100-line cap the oldest line is
  // dropped, so the length does not grow and cannot be used as the signal.
  const line = pushLine(state, "caller", canon, key, true);
  if (line) {
    state.placedLines[key] = line;
    state.placedRaw[key] = canon;
    if (itemId) state.placedItem[key] = itemId;
  }
}

function commitSlot(state: MachineState, slot: PendingUtterance): void {
  if (slot.role === "caller" && !canonicalizeOwner(slot.text).trim()) return;
  rememberPlaced(state, slot.key);
  if (slot.role === "caller") {
    if (slot.itemId) delete state.provisionalCaller[slot.itemId];
    if (slot.sealedEmpty) state.placedOpen[slot.key] = true;
    else delete state.placedOpen[slot.key];
    applyCallerText(state, slot.key, slot.itemId ?? "", slot.text, true);
    syncCallerGiving(state);
    return;
  }
  if (slot.key.startsWith("a:")) delete state.assistantByResponse[slot.key.slice(2)];
  const screened = screenAssistant(slot.text, {
    greeting: state.greeting,
    knownName: state.knownName,
    donorAllowed: state.callerAskedToGive,
  });
  if (screened.blocked) {
    addFlag(state, "guardrail");
    setFlagSource(state, `guard:${slot.key}`, canonicalizeOwner(slot.text), { injection: false });
    const line = pushLine(state, "assistant", screened.text, slot.key);
    if (line) state.placedLines[slot.key] = line;
    return;
  }
  const line = pushLine(state, slot.role, slot.text);
  if (line) state.placedLines[slot.key] = line;
}

function responseBlocked(state: MachineState, key: string): boolean {
  return state.guardedIds[key] === true || state.heldAudio[key]?.blocked === true;
}

function heldFor(state: MachineState, key: string): HeldResponseAudio {
  const existing = state.heldAudio[key];
  if (existing) return existing;
  const created: HeldResponseAudio = {
    chunks: [],
    blocked: false,
    passed: false,
    passedText: "",
    textDoneAtMs: null,
    firstMediaAtMs: null,
  };
  state.heldAudio[key] = created;
  return created;
}

/** Milliseconds from the passing full transcript to the first Twilio media frame. */
export function responseHoldMs(state: MachineState, responseId: string): number | null {
  const held = state.heldAudio[responseId];
  if (!held || held.textDoneAtMs === null || held.firstMediaAtMs === null) return null;
  return held.firstMediaAtMs - held.textDoneAtMs;
}

function maybeLatchGreeting(state: MachineState, id: string): void {
  if (!state.greetingOpen || state.greetingResponseId) return;
  state.greetingResponseId = id;
}

/** Greeting audio may stream only while two completed words still match the approved line. */
function greetingMayStream(state: MachineState, key: string): boolean {
  if (state.greetingResponseId !== key || !state.greetingOpen) return false;
  if (responseBlocked(state, key)) return false;
  return greetingPrefixReady(state.assistantByResponse[key] ?? "", state.greeting, false);
}

function allowTwilioAudio(state: MachineState, key: string): boolean {
  if (responseBlocked(state, key)) return false;
  if (state.heldAudio[key]?.passed === true) return true;
  return greetingMayStream(state, key);
}

function stampFirstMedia(state: MachineState, key: string): void {
  const held = heldFor(state, key);
  if (held.firstMediaAtMs === null) held.firstMediaAtMs = state.nowMs();
}

function enqueueApprovedAudio(state: MachineState, key: string, payload: string, outbound: Outbound[]): void {
  if (!allowTwilioAudio(state, key)) return;
  stampFirstMedia(state, key);
  if (!state.streamSid) {
    state.pendingTwilioAudio.push({ key, payload });
    if (state.pendingTwilioAudio.length > HELD_AUDIO_CAP) state.pendingTwilioAudio.shift();
    return;
  }
  outbound.push({
    to: "twilio",
    payload: { event: "media", streamSid: state.streamSid, media: { payload } },
  });
}

function markPassed(state: MachineState, key: string, text: string): void {
  const held = heldFor(state, key);
  held.passed = true;
  held.passedText = text;
  if (held.textDoneAtMs === null) held.textDoneAtMs = state.nowMs();
}

function releaseHeldAudio(state: MachineState, key: string, outbound: Outbound[]): void {
  const held = state.heldAudio[key];
  if (!held || held.blocked || state.guardedIds[key] || !held.passed) return;
  const chunks = held.chunks;
  held.chunks = [];
  for (const payload of chunks) enqueueApprovedAudio(state, key, payload, outbound);
}

/** Send greeting audio that was held until the running prefix reached two words. */
function flushGreetingHold(state: MachineState, key: string, outbound: Outbound[]): void {
  if (!greetingMayStream(state, key)) return;
  const held = state.heldAudio[key];
  if (!held || held.blocked || state.guardedIds[key]) return;
  const chunks = held.chunks;
  held.chunks = [];
  for (const payload of chunks) enqueueApprovedAudio(state, key, payload, outbound);
}

function dropResponseAudio(state: MachineState, key: string): void {
  const held = state.heldAudio[key];
  if (held) {
    held.chunks = [];
    held.blocked = true;
    held.passed = false;
  }
  if (state.pendingTwilioAudio.some((item) => item.key === key)) {
    state.pendingTwilioAudio = state.pendingTwilioAudio.filter((item) => item.key !== key);
  }
}

function holdResponseAudio(state: MachineState, key: string, payload: string): void {
  if (responseBlocked(state, key)) return;
  const held = heldFor(state, key);
  if (held.blocked || held.passed) return;
  held.chunks.push(payload);
  if (held.chunks.length > HELD_AUDIO_CAP) held.chunks.shift();
}

function speakRefusal(state: MachineState, clearId: string, outbound: Outbound[]): void {
  if (state.refusalSent[clearId]) return;
  state.refusalSent[clearId] = true;
  outbound.push({
    to: "xai",
    payload: buildForceMessage(spokenGreeting(state.pronunciation, PERSONAL_DETAIL_REFUSAL)),
  });
}

function refuseAssistant(state: MachineState, text: string, ids: string[], outbound: Outbound[]): string {
  addFlag(state, "guardrail");
  const sourceId = ids.find((id) => id.length > 0) ?? `guard:${state.lineSeq}`;
  setFlagSource(state, `guard:${sourceId}`, canonicalizeOwner(text), { injection: false });
  for (const id of ids) {
    if (id) {
      state.guardedIds[id] = true;
      dropResponseAudio(state, id);
    }
  }
  const key = ids.find((id) => id.length > 0) ?? "open";
  dropResponseAudio(state, key);
  if (state.streamSid && !state.guardCleared[key]) {
    state.guardCleared[key] = true;
    outbound.push({ to: "twilio", payload: { event: "clear", streamSid: state.streamSid } });
  }
  speakRefusal(state, key, outbound);
  return PERSONAL_DETAIL_REFUSAL;
}

/**
 * Transcript deltas may trip. They never release audio on their own, except a
 * pass that was already held for transcript.done. A full pass is transcript.done,
 * or response.done when that transcript never arrived.
 * The greeting response streams only after two completed words of the
 * approved line. A trailing partial word does not count and does not diverge.
 * A delta after transcript.done is checked as a finished transcript. If it
 * trips, Twilio is cleared and the stored line becomes the refusal.
 */
function guardAssistantText(
  state: MachineState,
  text: string,
  ids: string[],
  outbound: Outbound[],
  final: boolean,
): string {
  const key = ids.find((id) => id.length > 0) ?? "open";
  if (state.greetingResponseId === key && greetingDiverged(text, state.greeting, final)) {
    return refuseAssistant(state, text, ids, outbound);
  }
  if (ids.some((id) => id.length > 0 && state.guardedIds[id]) || responseBlocked(state, key)) {
    dropResponseAudio(state, key);
    for (const id of ids) {
      if (id) dropResponseAudio(state, id);
    }
    return PERSONAL_DETAIL_REFUSAL;
  }
  if (state.greetingResponseId === key) {
    if (greetingPrefixReady(text, state.greeting, final)) flushGreetingHold(state, key, outbound);
    if (final && greetingPrefixReady(text, state.greeting, final)) {
      markPassed(state, key, text);
      releaseHeldAudio(state, key, outbound);
    }
    return text;
  }
  const screened = screenAssistant(text, {
    greeting: state.greeting,
    knownName: state.knownName,
    donorAllowed: state.callerAskedToGive,
    final,
  });
  if (!screened.blocked) {
    if (!final || !text.trim()) return text;
    markPassed(state, key, text);
    releaseHeldAudio(state, key, outbound);
    return text;
  }
  return refuseAssistant(state, text, ids, outbound);
}

/** Text sealed for this response, including a delta appended after transcript.done. */
function assistantCheckedText(state: MachineState, id: string): string {
  if (state.assistantDone[id]) return state.assistantFinal[id] ?? "";
  return state.assistantByResponse[id] ?? "";
}

/** A late refusal replaces the assistant line already stored for this response. */
function replaceAssistantTranscript(state: MachineState, responseId: string, text: string): void {
  const clipped = redactSensitiveDigits(canonicalizeOwner(text).trim()).slice(0, 2000);
  if (!clipped) return;
  const key = assistantPendingKey(responseId);
  const placed = state.placedLines[key];
  if (placed) {
    placed.text = clipped;
    return;
  }
  const slot = findUtterance(state, key);
  if (slot) slot.text = clipped;
}

/** response.done is the full-text check when transcript.done never arrived. */
function finishResponseAudio(state: MachineState, id: string, outbound: Outbound[]): void {
  const held = state.heldAudio[id];
  if (state.guardedIds[id] || held?.blocked) {
    dropResponseAudio(state, id);
    return;
  }
  const current = assistantCheckedText(state, id);
  // A pass does not cover text appended after that pass.
  if (held?.passed) {
    if (current.trim() && current !== held.passedText) {
      const shown = guardAssistantText(state, current, [id], outbound, true);
      replaceAssistantTranscript(state, id, shown);
      return;
    }
    releaseHeldAudio(state, id, outbound);
    return;
  }
  if (!current.trim()) {
    if (state.greetingResponseId === id) return;
    if (held) held.chunks = [];
    return;
  }
  guardAssistantText(state, current, [id], outbound, true);
}

function flushUtterances(state: MachineState): void {
  let spins = 0;
  while (spins < 4000) {
    spins += 1;
    refillPending(state);
    const head = state.pendingUtterances[0];
    // A partial stays open until .completed or call end. Overflow must not seal it.
    if (!head || !head.ready) return;
    state.pendingUtterances.shift();
    commitSlot(state, head);
  }
}

/** How this caller event treats a line sealed by an empty .completed. */
type CallerSeal = "keep" | "open" | "close";

function upsertUtterance(
  state: MachineState,
  key: string,
  role: "caller" | "assistant",
  text: string,
  ready: boolean,
  itemId?: string,
  seal: CallerSeal = "keep",
): void {
  if (state.placedKeys[key]) {
    if (role !== "caller") return;
    // An empty snapshot must not wipe a line. A non-empty one replaces it.
    if (!text.trim()) return;
    applyCallerText(state, key, itemId ?? "", text, true);
    if (seal === "close") delete state.placedOpen[key];
    else if (seal === "open") state.placedOpen[key] = true;
    syncCallerGiving(state);
    return;
  }
  const slot = findUtterance(state, key);
  if (!slot) {
    if (!text.trim()) return;
    enqueueUtterance(state, { key, role, text, ready, itemId, sealedEmpty: seal === "open" });
  } else if (!text.trim()) {
    if (ready && slot.text.trim() && !slot.ready) {
      slot.ready = true;
      if (seal === "open") slot.sealedEmpty = true;
    }
  } else if (role === "caller") {
    // .updated and .completed are both cumulative. A revision wins even when it
    // does not start with the previous snapshot. An older prefix does not.
    const nextCanon = canonicalizeOwner(text).trim();
    const prevCanon = canonicalizeOwner(slot.text).trim();
    const relation = sameItemRelation(prevCanon, nextCanon);
    if (nextCanon && relation !== "stale" && relation !== "same") {
      slot.text = text;
      if (itemId) slot.itemId = itemId;
    } else if (itemId && !slot.itemId) {
      slot.itemId = itemId;
    }
    if (ready) slot.ready = true;
    if (seal === "open") slot.sealedEmpty = true;
    else if (seal === "close") slot.sealedEmpty = false;
  } else if (!slot.ready) {
    slot.text = text;
    if (ready) slot.ready = true;
  }
  flushUtterances(state);
}

const CALLER_GENERATION_CAP = 50;

function callerGenerationKey(itemId: string, contentIndex: number, generation: number): string {
  const base = callerStorageKey(itemId, contentIndex);
  return generation === 0 ? base : `${base}#${generation}`;
}

function callerSnapshot(state: MachineState, key: string): string {
  return state.placedRaw[key] ?? findUtterance(state, key)?.text ?? "";
}

/**
 * A missing item id is not one xAI item. A new sentence gets its own key.
 * A growing snapshot of the same sentence stays on the key it already has.
 */
function storageKeyFor(state: MachineState, itemId: string, contentIndex: number, text: string): string {
  const base = callerStorageKey(itemId, contentIndex);
  if (itemId !== "caller") return base;
  let last = base;
  for (let generation = 0; generation < CALLER_GENERATION_CAP; generation += 1) {
    const current = callerGenerationKey(itemId, contentIndex, generation);
    last = current;
    const raw = callerSnapshot(state, current);
    if (!raw || sameUtterance(raw, text)) return current;
  }
  return last;
}

function latestCallerKey(state: MachineState, itemId: string, contentIndex: number): string {
  const base = callerStorageKey(itemId, contentIndex);
  if (itemId !== "caller") return base;
  let last = base;
  for (let generation = 0; generation < CALLER_GENERATION_CAP; generation += 1) {
    const current = callerGenerationKey(itemId, contentIndex, generation);
    if (!callerSnapshot(state, current)) break;
    last = current;
  }
  return last;
}

/** Missing, blank, and huge ids share a bounded key instead of a fresh line per event. */
function callerItemId(record: Record<string, unknown>): string {
  const raw = record.item_id;
  if (typeof raw !== "string") return "caller";
  const trimmed = raw.trim().replace(/[\u0000-\u001F\u007F]/g, "");
  if (!trimmed) return "caller";
  const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  if (!safe || safe === "__proto__" || safe === "constructor" || safe === "prototype") return "caller";
  return safe;
}

/**
 * Clear giving phrases. Bare give, support, and offering do not count.
 * "forgive", "I support that.", and "Please give him my name." do not count.
 * After "I want to give" / "I'd like to give" / "can I give" / "how can I give",
 * only optional money, money to Owner / him / her / the ministry, a pronoun
 * plus money, or "to Owner / him / the ministry" may follow.
 * not, don't, do not, never, won't, will not, haven't, didn't, can't, and
 * cannot block the ask, donate, tithe, X Money, financially support, send
 * money, and give-to in the same clause. "yet" right after one of those words
 * is not a new clause.
 */
const GIVING_ASK =
  /\b(?:how can i give|i want to give|id like to give|can i give)(?: money(?: to (?:owner|him|her|the ministry))?| (?:him|her|you|owner) money| to (?:owner|him|the ministry))?$/;

const NEGATION_WORD = /^(?:not|dont|never|wont|havent|didnt|cant|cannot)$/;

const NEGATION_BEFORE = /(?:^|\s)(?:not|dont|never|wont|havent|didnt|cant|cannot)(?:\s|$)/;

function negatedBefore(sentence: string, index: number): boolean {
  const prior = sentence.slice(0, index);
  let start = 0;
  const butAt = prior.lastIndexOf(" but ");
  if (butAt >= 0) start = butAt + " but ".length;
  let from = 0;
  while (from < prior.length) {
    const at = prior.indexOf(" yet ", from);
    if (at < 0) break;
    const word = /(?:^|\s)(\S+)$/.exec(prior.slice(0, at))?.[1] ?? "";
    // "not yet" and "cannot yet" stay in this clause. "ready yet I want" splits.
    if (!NEGATION_WORD.test(word) && at + " yet ".length > start) start = at + " yet ".length;
    from = at + " yet ".length;
  }
  return NEGATION_BEFORE.test(prior.slice(start));
}

function hasUnguarded(sentence: string, source: string): boolean {
  const re = new RegExp(source, "g");
  let match = re.exec(sentence);
  while (match) {
    if (!negatedBefore(sentence, match.index)) return true;
    match = re.exec(sentence);
  }
  return false;
}

function sentenceGives(sentence: string): boolean {
  if (!sentence) return false;
  const ask = GIVING_ASK.exec(sentence);
  if (ask && !negatedBefore(sentence, ask.index)) return true;
  if (hasUnguarded(sentence, "\\btithes?\\b")) return true;
  if (hasUnguarded(sentence, "\\btithing\\b")) return true;
  if (hasUnguarded(sentence, "\\bx money\\b")) return true;
  if (hasUnguarded(sentence, "\\bsupport owner financially\\b")) return true;
  if (hasUnguarded(sentence, "\\bfinancially support\\b")) return true;
  if (hasUnguarded(sentence, "\\bdonat(?:e|es|ed|ion|ions|ing)\\b")) return true;
  if (hasUnguarded(sentence, "\\bsend (?:him|owner) money\\b")) return true;
  if (hasUnguarded(sentence, "\\bgive to (?:owner|him|the ministry)\\b")) return true;
  return false;
}

function mentionsGiving(text: string): boolean {
  const speech = normalizeSpeech(text);
  return speech.sentences.some((words) => sentenceGives(words.join(" ")));
}

/** The donor latch follows completed caller lines still on the call. Partials are skipped. */
function completedCallerAskedToGive(state: MachineState): boolean {
  for (const line of state.transcript) {
    if (line.role === "caller" && mentionsGiving(line.text)) return true;
  }
  const slots = state.pendingUtterances.concat(state.overflowUtterances);
  for (const slot of slots) {
    if (slot.role === "caller" && slot.ready && mentionsGiving(slot.text)) return true;
  }
  return false;
}

/** The latch follows whatever caller lines are stored right now. */
function syncCallerGiving(state: MachineState): void {
  state.callerAskedToGive = completedCallerAskedToGive(state);
}

function onCallerTranscript(state: MachineState, record: Record<string, unknown>, ready: boolean): void {
  const itemId = callerItemId(record);
  const contentIndex = contentIndexOf(record);
  const provided = eventTranscript(record.transcript);
  const key = provided
    ? storageKeyFor(state, itemId, contentIndex, provided)
    : latestCallerKey(state, itemId, contentIndex);
  const slot = findUtterance(state, key);
  const text = (provided || (ready ? slot?.text ?? state.placedRaw[key] ?? "" : "")).slice(0, 2000);
  // An empty .completed before any partial must not burn the id.
  // After a partial, it seals that partial. A later non-empty snapshot replaces it.
  if (!text.trim()) return;
  const canon = canonicalizeOwner(text).trim();
  const kept = sameItemText(state, itemId, key);
  const relation = canon && kept ? sameItemRelation(kept, canon) : "other";
  if (provided) {
    const source = relation === "stale" || relation === "same" ? kept : text;
    if (source) setFlagSource(state, key, source, { injection: true });
  }
  if (!ready) {
    // A stale prefix must not replace the provisional of the longer line.
    // Hangup would otherwise append it next to the already redacted line.
    if (relation === "stale" || relation === "same") dropPrefixProvisional(state, itemId, kept);
    else {
      const shown = preparedCaller(text);
      if (shown) rememberProvisional(state, itemId, shown);
    }
    upsertUtterance(state, key, "caller", text, false, itemId, "keep");
    syncCallerGiving(state);
    return;
  }
  delete state.provisionalCaller[itemId];
  upsertUtterance(state, key, "caller", text, true, itemId, provided ? "close" : "open");
  syncCallerGiving(state);
}

function flagIdForLine(state: MachineState, line: TranscriptLine): string | undefined {
  for (const [key, placed] of Object.entries(state.placedLines)) {
    if (placed === line) return key;
  }
  return undefined;
}

/**
 * Longest raw snapshot already kept for this item, including another content index.
 * A new key has no snapshot of its own until the cross-index check runs.
 */
function sameItemText(state: MachineState, itemId: string, key: string): string {
  const chunks: string[] = [];
  const own = callerSnapshot(state, key);
  if (own) chunks.push(own);
  if (itemId) {
    for (const [otherKey, line] of Object.entries(state.placedLines)) {
      if (state.placedItem[otherKey] !== itemId || line.role !== "caller") continue;
      const raw = state.placedRaw[otherKey] ?? "";
      if (raw) chunks.push(raw);
    }
    for (const slot of state.pendingUtterances.concat(state.overflowUtterances)) {
      if (slot.role === "caller" && slot.itemId === itemId && slot.text) chunks.push(slot.text);
    }
  }
  let best = "";
  let bestLen = 0;
  for (const chunk of chunks) {
    const len = foldSnapshot(chunk).length;
    if (len > bestLen) {
      best = chunk;
      bestLen = len;
    }
  }
  return best;
}

/**
 * The provisional for this item is a prefix of the utterance we kept.
 * Drop it so hangup cannot append the prefix beside the redacted line.
 * A provisional for a different sentence on the same synthetic id stays.
 */
function dropPrefixProvisional(state: MachineState, itemId: string, keptRaw: string): void {
  if (!itemId || !keptRaw) return;
  const current = state.provisionalCaller[itemId];
  if (!current) return;
  const relation = sameItemRelation(keptRaw, current);
  if (relation === "stale" || relation === "same") delete state.provisionalCaller[itemId];
}

function pushLeftoverCaller(state: MachineState, text: string): void {
  const canon = canonicalizeOwner(text).trim();
  if (!canon) return;
  const clipped = preparedCaller(canon);
  if (!clipped) return;
  for (const line of state.transcript) {
    if (line.role !== "caller") continue;
    let covered: SnapshotRelation = sameItemRelation(line.text, clipped);
    for (const [key, placed] of Object.entries(state.placedLines)) {
      if (placed !== line) continue;
      const raw = state.placedRaw[key] ?? "";
      if (!raw) continue;
      const relation = sameItemRelation(raw, canon);
      if (relation === "stale" || relation === "same") covered = relation;
      else if (covered === "other" && relation === "extends") covered = "extends";
    }
    if (covered === "stale" || covered === "same") return;
    if (covered === "extends") {
      line.text = clipped;
      const id = flagIdForLine(state, line);
      setFlagSource(state, id ?? `leftover:${state.lineSeq++}`, canon, { injection: true });
      syncCallerGiving(state);
      return;
    }
  }
  pushLine(state, "caller", clipped);
  syncCallerGiving(state);
}

function commitOpenAssistants(state: MachineState): void {
  for (const [key, text] of Object.entries(state.assistantByResponse)) {
    const pendingKey = assistantPendingKey(key);
    if (state.placedKeys[pendingKey]) continue;
    const slot = findUtterance(state, pendingKey);
    if (!slot) {
      enqueueUtterance(state, { key: pendingKey, role: "assistant", text, ready: true });
    } else {
      slot.ready = true;
      if (!slot.text) slot.text = text;
    }
  }
  state.assistantByResponse = {};
  for (const slot of state.pendingUtterances) {
    if (slot.role === "assistant") slot.ready = true;
  }
  for (const slot of state.overflowUtterances) {
    if (slot.role === "assistant") slot.ready = true;
  }
  flushUtterances(state);
}

function sessionUpdate(state: MachineState): Outbound {
  return {
    to: "xai",
    payload: buildSessionUpdate({
      voice: state.activeVoice,
      instructions: state.instructions,
      pronunciation: state.pronunciation,
    }),
  };
}

function flushCallerAudio(state: MachineState, outbound: Outbound[]): void {
  for (const audio of state.pendingAudio) {
    outbound.push({ to: "xai", payload: { type: "input_audio_buffer.append", audio } });
  }
  state.pendingAudio = [];
}

function flushTwilioAudio(state: MachineState, outbound: Outbound[]): void {
  if (!state.streamSid) return;
  const queued = state.pendingTwilioAudio;
  state.pendingTwilioAudio = [];
  for (const item of queued) {
    if (responseBlocked(state, item.key) || state.guardedIds[item.key]) continue;
    const passed = state.heldAudio[item.key]?.passed === true;
    const greetingText = state.assistantByResponse[item.key] ?? state.assistantFinal[item.key] ?? "";
    const greetingReady =
      state.greetingResponseId === item.key && greetingPrefixReady(greetingText, state.greeting, false);
    // A start event must not flush audio that has not passed the full-text check.
    // Greeting audio waits until a non-empty prefix of at least two words matches.
    if (!passed && !greetingReady) continue;
    stampFirstMedia(state, item.key);
    outbound.push({
      to: "twilio",
      payload: { event: "media", streamSid: state.streamSid, media: { payload: item.payload } },
    });
  }
}

function markReady(state: MachineState, outbound: Outbound[]): void {
  state.xaiReady = true;
  if (!state.greeted) {
    state.greeted = true;
    state.greetingOpen = true;
    outbound.push({ to: "xai", payload: buildGreetingItem(state.pronunciation, state.greeting) });
    pushLine(state, "assistant", state.greeting);
  }
  flushCallerAudio(state, outbound);
}

export function onXaiOpen(state: MachineState): Step {
  const outbound: Outbound[] = [];
  if (!state.sessionUpdateSent) {
    state.sessionUpdateSent = true;
    outbound.push(sessionUpdate(state));
  }
  return { state, outbound };
}

function referencesVoice(event: Record<string, unknown>): boolean {
  const parts: string[] = [];
  const nested = asRecord(event.error);
  for (const source of [event, nested]) {
    if (!source) continue;
    for (const key of ["message", "code", "param", "type"]) {
      const value = source[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join(" ").toLowerCase().includes("voice");
}

export function onXaiEvent(state: MachineState, event: unknown): Step {
  const outbound: Outbound[] = [];
  const record = asRecord(event);
  if (!record) return { state, outbound };
  debugXaiEvent(record);
  const type = str(record.type) ?? "";

  if (type === "error") {
    const voiceError = referencesVoice(record);
    // A second error while leo is starting is not proof that leo failed.
    // The ready timeout ends the call if session.updated never arrives.
    if (voiceError && state.awaitingVoiceFallback) {
      return {
        state,
        outbound,
        log: { level: "warn", message: "xAI voice fallback is still starting" },
      };
    }
    if (voiceError && !state.voiceFallbackUsed && state.activeVoice !== FALLBACK_VOICE) {
      state.voiceFallbackUsed = true;
      state.awaitingVoiceFallback = true;
      state.activeVoice = FALLBACK_VOICE;
      state.xaiReady = false;
      outbound.push(sessionUpdate(state));
      return {
        state,
        outbound,
        log: {
          level: "warn",
          message: "xAI session rejected the configured voice; retrying session.update with fallback voice leo",
        },
      };
    }
    const nested = asRecord(record.error);
    const code = str(nested?.code) ?? str(record.code) ?? "";
    const message = str(nested?.message) ?? str(record.message) ?? "";
    const detail = clip([code, message].filter(Boolean).join(" "));
    const log = { level: "warn" as const, message: detail ? `xAI error ${detail}` : "xAI error" };
    if (!state.greeted) {
      return {
        state,
        outbound,
        fatal: true,
        log:
          voiceError && state.activeVoice === FALLBACK_VOICE
            ? { level: "warn", message: "xAI session rejected voice leo; ending call" }
            : log,
      };
    }
    return { state, outbound, log };
  }

  if (type === "session.updated") {
    state.awaitingVoiceFallback = false;
    markReady(state, outbound);
    return { state, outbound };
  }

  if (type === "response.created") {
    const response = asRecord(record.response);
    const id = str(response?.id) ?? str(record.response_id);
    if (id) {
      state.activeResponseId = id;
      maybeLatchGreeting(state, id);
    }
    const openKey = assistantPendingKey(`assistant:${state.assistantEpoch}`);
    const open = state.pendingUtterances.find((item) => item.key === openKey);
    if (!open || open.ready) state.assistantEpoch += 1;
    return { state, outbound };
  }

  if (type === "response.done") {
    state.greetingOpen = false;
    const response = asRecord(record.response);
    const id = str(response?.id) ?? str(record.response_id);
    // A barge-in that has not learned a response id must not swallow the next turn.
    if (
      state.suppressUnscopedAudio &&
      (!id || state.suppressedResponseId === null || id === state.suppressedResponseId)
    ) {
      state.suppressUnscopedAudio = false;
      state.suppressedResponseId = null;
    }
    if (id) finishResponseAudio(state, id, outbound);
    return { state, outbound };
  }

  if (type === "response.output_audio.delta" || type === "response.audio.delta") {
    const delta = str(record.delta);
    if (!delta) return { state, outbound };
    const responseId = str(record.response_id);
    const audioKey = responseKey(state, record);
    if ((responseId && state.guardedIds[responseId]) || state.guardedIds[audioKey] || responseBlocked(state, audioKey)) {
      return { state, outbound };
    }
    if (state.suppressUnscopedAudio) {
      const sameTurn =
        !responseId || state.suppressedResponseId === null || responseId === state.suppressedResponseId;
      if (sameTurn) {
        if (responseId && state.suppressedResponseId === null) state.suppressedResponseId = responseId;
        if (responseId) state.activeResponseId = responseId;
        return { state, outbound };
      }
      state.suppressUnscopedAudio = false;
      state.suppressedResponseId = null;
    }
    if (responseId) {
      state.activeResponseId = responseId;
      maybeLatchGreeting(state, responseId);
    }
    // Only the latched greeting streams before its transcript is finished.
    // Every other response, including one that arrives while the greeting is open, stays held.
    if (allowTwilioAudio(state, audioKey)) {
      enqueueApprovedAudio(state, audioKey, delta, outbound);
      return { state, outbound };
    }
    holdResponseAudio(state, audioKey, delta);
    return { state, outbound };
  }

  if (type === "input_audio_buffer.speech_started") {
    // force_message interruptible:false must play out. Clearing Twilio here chops the greeting.
    if (state.greetingOpen) {
      logInfo("suppressed during greeting");
      return { state, outbound };
    }
    // Barge-in cuts the response off before transcript.done. Keep one line of what was spoken.
    // Caller items stay provisional. speech_stopped is ignored: the caller final is .completed,
    // which often arrives after this event and after the assistant turn has already started.
    commitOpenAssistants(state);
    state.pendingTwilioAudio = [];
    for (const held of Object.values(state.heldAudio)) held.chunks = [];
    state.suppressedResponseId = state.activeResponseId;
    state.suppressUnscopedAudio = true;
    if (state.streamSid) {
      logInfo("barge_in speech_started during assistant audio, clear sent");
      outbound.push({ to: "twilio", payload: { event: "clear", streamSid: state.streamSid } });
    } else {
      logInfo("barge_in speech_started");
    }
    return { state, outbound };
  }

  if (type === "response.output_audio_transcript.delta") {
    const key = responseKey(state, record);
    const heard = str(record.response_id);
    if (heard) maybeLatchGreeting(state, heard);
    const pendingKey = assistantPendingKey(key);
    const delta = str(record.delta) ?? "";
    if (state.assistantDone[key]) {
      const full = `${state.assistantFinal[key] ?? ""}${delta}`;
      state.assistantFinal[key] = full;
      const ids = [key, heard ?? ""];
      // The same finished-transcript check as transcript.done, on the whole line.
      const shown = guardAssistantText(state, full, ids, outbound, true);
      replaceAssistantTranscript(state, key, shown);
      return { state, outbound };
    }
    if (state.placedKeys[pendingKey]) return { state, outbound };
    const next = (state.assistantByResponse[key] ?? "") + delta;
    state.assistantByResponse[key] = next;
    const shown = guardAssistantText(
      state,
      state.assistantByResponse[key],
      [key, str(record.response_id) ?? ""],
      outbound,
      false,
    );
    upsertUtterance(state, pendingKey, "assistant", shown, false);
    return { state, outbound };
  }

  if (type === "response.output_audio_transcript.done") {
    const key = responseKey(state, record);
    const heard = str(record.response_id);
    if (heard) maybeLatchGreeting(state, heard);
    const pendingKey = assistantPendingKey(key);
    const provided = eventTranscript(record.transcript);
    if (state.assistantDone[key]) {
      const text = provided || state.assistantFinal[key] || state.assistantByResponse[key] || "";
      if (provided) state.assistantFinal[key] = provided;
      if (text.trim()) guardAssistantText(state, text, [key, heard ?? ""], outbound, true);
      return { state, outbound };
    }
    if (state.placedKeys[pendingKey]) return { state, outbound };
    const text = provided || state.assistantByResponse[key] || "";
    state.assistantDone[key] = true;
    state.assistantFinal[key] = text;
    delete state.assistantByResponse[key];
    const shown = guardAssistantText(state, text, [key, heard ?? ""], outbound, true);
    upsertUtterance(state, pendingKey, "assistant", shown, true);
    return { state, outbound };
  }

  if (type === "conversation.item.input_audio_transcription.updated") {
    // Cumulative for this item and content index, and it may revise earlier words.
    onCallerTranscript(state, record, false);
    return { state, outbound };
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    // Cumulative for this item, same as .updated. xAI repeats it as the text grows
    // and again after speech_stopped and committed. It is not a new utterance.
    onCallerTranscript(state, record, true);
    return { state, outbound };
  }

  if (type === "response.function_call_arguments.done") {
    const callId = str(record.call_id);
    if (!callId) {
      return { state, outbound, log: { level: "warn", message: "function call missing call_id" } };
    }
    if (state.handledCallIds.includes(callId)) return { state, outbound };
    state.handledCallIds.push(callId);
    if (state.handledCallIds.length > 20) state.handledCallIds.shift();

    const toolName = str(record.name);
    if (toolName !== "record_message") {
      outbound.push({ to: "xai", payload: buildFunctionOutput(callId, { ok: false, error: "unsupported_tool" }) });
      outbound.push({ to: "xai", payload: buildResponseCreate() });
      return { state, outbound };
    }

    const parsed = parseArgs(record.arguments);
    const nameField = cleanField(parsed?.name);
    const callbackField = cleanField(parsed?.callback_number);
    const reasonField = cleanField(parsed?.reason);
    const urgentField = parsed && typeof parsed.urgent === "boolean" ? parsed.urgent : undefined;
    const urgentReasonField = cleanField(parsed?.urgent_reason);
    const hasMessageField = Boolean(nameField || callbackField || reasonField);
    const hasQuestions =
      Array.isArray(parsed?.questions) && parsed.questions.some((item) => storedQuestion(state, item) !== null);
    if (!parsed || (!hasMessageField && urgentField === undefined && !hasQuestions)) {
      outbound.push({
        to: "xai",
        payload: buildFunctionOutput(callId, {
          ok: false,
          error: "a name, callback_number, or reason is required",
        }),
      });
      outbound.push({ to: "xai", payload: buildResponseCreate() });
      return { state, outbound };
    }
    if (!hasMessageField && !state.messageRecorded && !hasQuestions) {
      outbound.push({
        to: "xai",
        payload: buildFunctionOutput(callId, {
          ok: false,
          error: "a name, callback_number, or reason is required",
        }),
      });
      outbound.push({ to: "xai", payload: buildResponseCreate() });
      return { state, outbound };
    }
    if (hasMessageField) {
      const callerName = nameField ?? state.messageSource.name;
      const reason = reasonField ?? state.messageSource.reason;
      let callback = callbackField ?? state.messageSource.callback_number;
      if (!callback) callback = cleanField(state.callerNumber);
      state.messageSource = { name: callerName, callback_number: callback, reason };
      state.message = {
        name: callerName ? redactSensitiveDigits(callerName) : null,
        callback_number: storedPhone(callback, state.callerNumber),
        reason: reason ? redactSensitiveDigits(reason) : null,
      };
      state.messageRecorded = true;
    }
    if (urgentField === true) state.urgentAsk = true;
    if (urgentField === false) {
      state.urgentAsk = false;
      state.urgentReasonSource = null;
    }
    if (urgentReasonField && state.urgentAsk) state.urgentReasonSource = urgentReasonField;
    syncMessageFlags(state);
    if (Array.isArray(parsed.questions)) mergeQuestions(state, parsed.questions);
    const urgentAccepted = state.flags.includes("urgent");
    const output: Record<string, unknown> = { ok: true };
    if (urgentField !== undefined) {
      output.urgent = urgentAccepted;
      if (urgentAccepted) output.say = URGENT_NOTICE;
    }
    if (Array.isArray(parsed.questions)) output.questions_recorded = state.questions.length;
    outbound.push({ to: "xai", payload: buildFunctionOutput(callId, output) });
    outbound.push({ to: "xai", payload: buildResponseCreate() });
    return { state, outbound };
  }

  return { state, outbound };
}

/** Cap on the original question. Marks stay so the skeleton can delete them instead of splitting words. */
function rawQuestion(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const chars = Array.from(value);
  return chars.length <= 500 ? value : chars.slice(0, 500).join("");
}

function storedQuestion(
  state: MachineState,
  value: unknown,
): { question: string; answered: boolean; raw: string } | null {
  const record = asRecord(value);
  if (!record || typeof record.answered !== "boolean") return null;
  const raw = rawQuestion(record.question);
  if (!raw) return null;
  const question = normalizeQuestions([{ question: raw, answered: false }])[0]?.question;
  if (!question) return null;
  const topic = typeof record.topic === "string" ? record.topic : null;
  const answered =
    record.answered === true &&
    allowAnsweredQuestion(
      raw,
      topic,
      state.approvedTopics.map((item) => ({ topic: item })),
    );
  return { question, answered, raw };
}

function syncQuestionFlags(state: MachineState): void {
  for (let i = 0; i < state.questions.length; i += 1) {
    setFlagSource(state, `q:${i}`, state.questionRaw[i] ?? "", { injection: true });
  }
  for (let i = state.questions.length; i < MAX_SUMMARY_QUESTIONS; i += 1) {
    if (state.flagSources[`q:${i}`]) forgetFlagSource(state, `q:${i}`);
  }
}

function mergeQuestions(state: MachineState, value: unknown): void {
  if (!Array.isArray(value)) return;
  let overflow = 0;
  for (const item of value) {
    const next = storedQuestion(state, item);
    if (!next) continue;
    const key = next.question.toLowerCase();
    const index = state.questions.findIndex((row) => row.question.toLowerCase() === key);
    if (index >= 0) {
      state.questions[index] = { question: next.question, answered: next.answered };
      state.questionRaw[index] = next.raw;
      continue;
    }
    if (state.questions.length >= MAX_SUMMARY_QUESTIONS) {
      overflow += 1;
      setFlagSource(state, `q:overflow:${overflow}`, next.raw, { injection: true });
      continue;
    }
    state.questions.push({ question: next.question, answered: next.answered });
    state.questionRaw.push(next.raw);
  }
  syncQuestionFlags(state);
}

function parseArgs(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

export function onTwilioEvent(state: MachineState, event: unknown): Step {
  const outbound: Outbound[] = [];
  const record = asRecord(event);
  if (!record) return { state, outbound };
  const name = str(record.event) ?? "";

  if (name === "start") {
    const start = asRecord(record.start) ?? {};
    const streamSid = str(record.streamSid) ?? str(start.streamSid);
    const callSid = str(start.callSid);
    if (callSid && state.callSid && callSid !== state.callSid) {
      return { state, outbound, fatal: true, log: { level: "warn", message: "media stream callSid mismatch" } };
    }
    if (streamSid) state.streamSid = streamSid;
    if (callSid && !state.callSid) state.callSid = callSid;
    flushTwilioAudio(state, outbound);
    return { state, outbound };
  }

  if (name === "media") {
    const media = asRecord(record.media);
    const track = str(media?.track);
    if (track && track !== "inbound") return { state, outbound };
    const payload = str(media?.payload);
    if (!payload) return { state, outbound };
    if (!state.xaiReady) {
      state.pendingAudio.push(payload);
      if (state.pendingAudio.length > 500) state.pendingAudio.shift();
      return { state, outbound };
    }
    outbound.push({ to: "xai", payload: { type: "input_audio_buffer.append", audio: payload } });
    return { state, outbound };
  }

  if (name === "stop") {
    state.ended = true;
    return { state, outbound };
  }

  return { state, outbound };
}

const AUTO_REASON_MAX = 200;

function clipExcerpt(text: string, max: number): string {
  if (text.length <= max) return text.trim();
  return trimPartialDigitRun(text.slice(0, max));
}

function callerExcerpt(state: MachineState): string | null {
  const joined = state.transcript
    .filter((line) => line.role === "caller")
    .map((line) => line.text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!joined) return null;
  // Redact the whole excerpt before clipping, so a cut cannot leave phone digits.
  const redacted = redactFallbackExcerpt(joined);
  if (!redacted) return null;
  if (redacted.length <= AUTO_REASON_MAX) return redacted;
  const clipped = clipExcerpt(redacted, AUTO_REASON_MAX);
  return redactFallbackExcerpt(clipped) || null;
}

/** Used when the model never called record_message. Name stays empty. */
function applyAutoSummary(state: MachineState): void {
  if (state.messageRecorded) return;
  const reason = callerExcerpt(state);
  const callback = cleanField(state.callerNumber);
  state.messageSource = { name: null, callback_number: callback, reason };
  state.message = {
    name: null,
    callback_number: storedPhone(callback, state.callerNumber),
    reason,
  };
  addFlag(state, "auto_summary");
  syncMessageFlags(state);
}

export function finalizeCall(state: MachineState, endedAtMs: number): CallLogEntry {
  for (const slot of state.pendingUtterances) slot.ready = true;
  for (const slot of state.overflowUtterances) slot.ready = true;
  flushUtterances(state);
  const leftovers = Object.entries(state.provisionalCaller);
  state.provisionalCaller = {};
  for (const [, text] of leftovers) pushLeftoverCaller(state, text);
  commitOpenAssistants(state);
  applyAutoSummary(state);
  return {
    id: state.id,
    call_sid: state.callSid,
    disposition: "connected",
    caller_number: redactNullablePhone(state.callerNumber),
    message: {
      name: redactNullableText(state.message.name),
      callback_number: redactNullablePhone(state.message.callback_number),
      reason: redactNullableText(state.message.reason),
    },
    transcript_summary: redactStoredSummary(buildTranscriptSummary(state.transcript)),
    questions: normalizeQuestions(state.questions),
    start_time: new Date(state.startedAtMs).toISOString(),
    end_time: new Date(endedAtMs).toISOString(),
    flags: normalizeFlags(state.flags),
  };
}
