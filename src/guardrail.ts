import { spokenGreeting } from "./bridge/protocol.js";
import { normalizeSpeech } from "./normalize.js";
import { mentionsMoney } from "./money.js";
import {
  AVAILABILITY_ANSWER,
  DONOR_X_MONEY,
  FAMILY_WARMTH,
  LINE_ANSWER,
  LIST_DEFLECTION,
  PERSONAL_DETAIL_REFUSAL,
  PERSONAL_REFUSAL,
  REACH_ANSWER,
  UNANSWERED_QUESTION,
  URGENT_NOTICE,
  isPersonalQuestion,
} from "./prompt.js";
import { foldDigitRuns, hasSensitiveNumber } from "./redact.js";

const SAFE_LINES = [
  PERSONAL_DETAIL_REFUSAL,
  PERSONAL_REFUSAL,
  UNANSWERED_QUESTION,
  LIST_DEFLECTION,
  FAMILY_WARMTH,
  AVAILABILITY_ANSWER,
  REACH_ANSWER,
  LINE_ANSWER,
  URGENT_NOTICE,
  "Thank you, that means a lot. I'll make sure Owner gets your message.",
  "Got it all. I'll make sure Owner hears it. Have a great one!",
];

const SAFE = new Set(SAFE_LINES.map((line) => normalizeSpeech(line).text));

function cardOrBank(text: string): boolean {
  return (
    /\b(card|debit|credit)\s+(number|no|details)\b/.test(text) ||
    /\b(bank|routing|account)\s+(account|number|details|no)\b/.test(text) ||
    /\bbank account\b/.test(text) ||
    /\brouting number\b/.test(text) ||
    /\bcvv\b/.test(text) ||
    /\bsocial security\b/.test(text) ||
    /\bssn\b/.test(text)
  );
}

const DONOR_TEXT = new Set([
  normalizeSpeech(DONOR_X_MONEY).text,
  normalizeSpeech(spokenGreeting(true, DONOR_X_MONEY)).text,
]);

/**
 * Spoken and written digits share foldDigitRuns, the same pass as the digit
 * allowlist. An answer may not speak a run of 7 or more. A year is 4.
 */
function hasAnswerPhone(text: string): boolean {
  return /\d{7,}/.test(foldDigitRuns(text));
}

function hasPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

const CHILD_AGE =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|\\d{1,2})";

function childAnswer(text: string): boolean {
  if (hasPhrase(text, "little girl") || hasPhrase(text, "little boy") || hasPhrase(text, "little kid")) return true;
  if (hasPhrase(text, "in school") || hasPhrase(text, "at school")) return true;
  const who = "(?:girl|boy|kid|child|daughter|son)";
  const aged = new RegExp(`\\b${who}\\b(?:\\s+\\w+){0,4}\\s+is\\s+${CHILD_AGE}\\b`);
  if (!aged.test(text)) return false;
  const notAge = new RegExp(`\\b${who}\\b(?:\\s+\\w+){0,4}\\s+is\\s+one\\s+of\\b`);
  return !notAge.test(text);
}

function payAnswer(text: string): boolean {
  return hasPhrase(text, "six figures") || hasPhrase(text, "six figure");
}

function livesNearby(text: string): boolean {
  return (
    hasPhrase(text, "lives nearby") ||
    hasPhrase(text, "live nearby") ||
    hasPhrase(text, "lived nearby") ||
    hasPhrase(text, "lives near") ||
    hasPhrase(text, "live near") ||
    hasPhrase(text, "lived near")
  );
}

function textWithoutDonor(text: string): string {
  const speech = normalizeSpeech(text);
  return speech.sentences
    .map((sentence) => sentence.join(" "))
    .filter((key) => !DONOR_TEXT.has(key))
    .join(" ");
}

function bodyLeaks(text: string, knownName: string | null, donorAllowed: boolean, final: boolean): boolean {
  const speech = normalizeSpeech(text);
  if (!speech.text) return false;
  const moneySource = donorAllowed ? textWithoutDonor(text) : text;
  if (mentionsMoney(moneySource)) return true;
  if (payAnswer(speech.text) || childAnswer(speech.text) || livesNearby(speech.text)) return true;
  return isPersonalQuestion(text, knownName, final);
}

/** "Mom, I can take a message." addresses the caller. "Mom lives nearby." does not. */
function addressedOnly(text: string, knownName: string, donorAllowed: boolean): boolean {
  const name = knownName.trim();
  if (!name) return false;
  const trimmed = text.trim();
  if (trimmed.length < name.length) return false;
  if (trimmed.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
  const afterName = trimmed.slice(name.length);
  if (!afterName.startsWith(",")) return false;
  const rest = afterName.slice(1).trim();
  if (!rest) return true;
  const restSpeech = normalizeSpeech(rest);
  if (hasSensitiveNumber(rest) || hasAnswerPhone(rest) || cardOrBank(restSpeech.text)) return false;
  return !bodyLeaks(rest, knownName, donorAllowed, true);
}

/**
 * Backup check on a model answer. Private facts, card or bank details, a phone
 * number, and money talk other than the exact donor X Money sentence are leaks.
 * A place or schedule sentence is a leak unless it is an approved public line.
 * A known display name is not removed before that check. A comma address such
 * as "Mom, I can take a message." is still allowed. "Mom lives nearby." is not.
 */
export function answerLeaks(
  text: string,
  knownName: string | null = null,
  donorAllowed = false,
  final = true,
): boolean {
  const speech = normalizeSpeech(text);
  if (!speech.text) return false;
  if (SAFE.has(speech.text) || (donorAllowed && DONOR_TEXT.has(speech.text))) return false;
  if (hasSensitiveNumber(text) || hasAnswerPhone(text) || cardOrBank(speech.text)) return true;
  if (!bodyLeaks(text, knownName, donorAllowed, final)) return false;
  if (knownName && addressedOnly(text, knownName, donorAllowed)) return false;
  return true;
}

export interface AssistantScreen {
  blocked: boolean;
  text: string;
}

const greetingWordsCache = new Map<string, string[][]>();

function greetingWordLists(greeting: string): string[][] {
  const cached = greetingWordsCache.get(greeting);
  if (cached) return cached;
  const lists: string[][] = [];
  for (const line of [greeting, spokenGreeting(true, greeting)]) {
    const words = normalizeSpeech(line, { final: true }).words;
    if (words.length === 0) continue;
    const key = words.join(" ");
    if (lists.some((existing) => existing.join(" ") === key)) continue;
    lists.push(words);
  }
  greetingWordsCache.set(greeting, lists);
  return lists;
}

function isWholeWordPrefix(words: readonly string[], greeting: string): boolean {
  if (words.length === 0) return false;
  return greetingWordLists(greeting).some((line) => {
    if (words.length > line.length) return false;
    for (let i = 0; i < words.length; i += 1) {
      if (words[i] !== line[i]) return false;
    }
    return true;
  });
}

function completedWords(text: string, final: boolean): string[] {
  return normalizeSpeech(text, { final }).words;
}

/**
 * A trailing partial word does not count until space, punctuation, or
 * transcript.done. "Hi t" is still only "hi".
 */
export function matchesApprovedGreeting(text: string, greeting: string): boolean {
  return isWholeWordPrefix(completedWords(text, false), greeting);
}

/** Two or more completed words of a real prefix may stream. A partial word does not. */
export function greetingPrefixReady(text: string, greeting: string, final = false): boolean {
  const words = completedWords(text, final);
  if (words.length < 2) return false;
  return isWholeWordPrefix(words, greeting);
}

/** Blank text has not diverged. A partial second word has not either. */
export function greetingDiverged(text: string, greeting: string, final = false): boolean {
  const words = completedWords(text, final);
  if (words.length === 0) return false;
  return !isWholeWordPrefix(words, greeting);
}

/** A scripted greeting is not a model answer. Whole words of it are still the greeting. */
export function screenAssistant(
  text: string,
  opts?: { greeting?: string | null; knownName?: string | null; donorAllowed?: boolean; final?: boolean },
): AssistantScreen {
  const trimmed = text.trim();
  if (!trimmed) return { blocked: false, text };
  if (opts?.greeting && isWholeWordPrefix(completedWords(trimmed, true), opts.greeting)) {
    return { blocked: false, text };
  }
  const donorAllowed = opts?.donorAllowed ?? false;
  const final = opts?.final !== false;
  if (!answerLeaks(trimmed, opts?.knownName ?? null, donorAllowed, final)) return { blocked: false, text };
  return { blocked: true, text: PERSONAL_DETAIL_REFUSAL };
}
