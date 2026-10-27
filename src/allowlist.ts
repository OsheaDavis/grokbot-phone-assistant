import { spokenGreeting } from "./bridge/protocol.js";
import { FALLBACK_GREETING, greetingLines, loadGreetingCatalog } from "./greeting.js";
import { normalizeSpeech } from "./normalize.js";

/**
 * The only sentences that may contain a place, a time, or a closed topic.
 * Four groups, whole sentence after normalization, or a pattern anchored to the whole sentence.
 * 1. Greetings. 2. Taking a message. 3. The one donor sentence. 4. Grok-mode warmth and a stored-name hello.
 */

const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const TIMES_OF_DAY = "morning|afternoon|evening|night";

const GREETING_PATTERNS: readonly RegExp[] = [
  new RegExp(`^good (${TIMES_OF_DAY})$`),
  new RegExp(`^happy (${WEEKDAYS})$`),
  new RegExp(`^have a (good|great) (${TIMES_OF_DAY})$`),
  /^take care$/,
];

/** Bare coded closers. A stored-name lead is checked separately. */
const KNOWN_LEAD_PATTERNS: readonly RegExp[] = [/^good to hear from you$/, /^thank you for calling$/];

/**
 * Asking for the caller's own name, callback, or reason.
 * A read-back of the name or the reason is not approved.
 * Callback-number questions and confirmations are.
 */
const MESSAGE_QUESTIONS: readonly RegExp[] = [
  /^i can take a message$/,
  /^please leave a message$/,
  /^feel free to leave a message$/,
  /^(what is|whats|may i have|can i (have|get)|could i (have|get)|please (tell me|give me)) your name$/,
  /^(and )?your name( please)?$/,
  /^who (is calling|am i speaking (with|to))$/,
  /^(what is|whats|may i have|can i (have|get)|could i (have|get)) your (callback|phone) number$/,
  /^(and )?your (callback|phone) number( please)?$/,
  /^is the number you are calling from( the best callback| ok| okay)?$/,
  /^can (he|owner) reach you (at the number you are calling from|on the number you are calling from)$/,
  /^(what is|whats) (the reason( for your call)?|your reason)$/,
  /^(and )?the reason( for your call)?$/,
  /^why are you calling$/,
  /^what (can|should) i tell (him|owner)$/,
  /^what message can i (leave|take)( for (him|owner))?$/,
];

const TIME_WORDS = new Set<string>([
  "tomorrow", "tonight", "yesterday", "today", "calendar", "schedule",
  "appointment", "free", "later", "soon", "morning", "afternoon", "evening",
  "night", "weekend", "weekly", "when",
  "week", "weeks", "weekday", "weekdays", "month", "months",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "noon", "midnight", "oclock", "year", "years", "day", "days",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  "holiday", "holidays",
]);

const PLACE_NOUNS = new Set<string>([
  "hospital", "hospitals", "church", "churches", "park", "parks", "gym", "gyms",
  "store", "stores", "shop", "shops", "river", "rivers", "booth", "booths",
  "clinic", "clinics", "cafe", "cafes", "school", "schools",
]);

const CLOSED_TOPIC = new Set<string>([
  "ministry", "ministries", "website", "websites", "church", "churches", "exampleowner", "exampleownerorg",
]);

const DET = new Set(["the", "a", "an", "his", "her", "their", "owners", "that", "this", "your", "our"]);
const PRONOUN = new Set(["it", "him", "her", "me", "you", "us", "them", "there", "here"]);
const AT_STOP = new Set(["all", "once", "least", "last", "first", "best", "most", "him", "her", "me", "you", "us", "them", "it", "long"]);
const RELATION = new Set(["until", "after", "before", "back", "busy", "available"]);
const CATCH = new Set(["him", "her", "them", "owner"]);

const ADDRESS =
  /\b\d{1,6}\s+(?:oak|main|elm|pine|maple|cedar|street|st|avenue|ave|road|rd|lane|ln|drive|dr|blvd|boulevard|way|court|ct|circle|cir|place|pl|parkway|pkwy|trail|trl)\b/;

const EXACT = new Set<string>();

function addLine(line: string): void {
  const speech = normalizeSpeech(line);
  for (const sentence of speech.sentences) {
    const key = sentence.join(" ");
    if (key) EXACT.add(key);
  }
}

const MESSAGE_EXACT = [
  "I can take a message.",
  "Please leave a message.",
  "Feel free to leave a message.",
  "This line is not a direct phone number.",
  "I take messages for him.",
  "I'm Owner's AI Bot; I take messages for him",
  "the best way is to leave a message with me and he'll get it",
  "Owner isn't available; I can take a message.",
  "Owner isn't available right now, but I'll make sure he gets your message",
  "As Owner's AI Bot I'm not allowed to give that kind of information, but please leave a message and I'll pass it to him so he can get back to you.",
  "I can't answer that, but I can take a message.",
  "I'm flagging this as urgent so it reaches him right away.",
  "Family calls are my favorite kind!",
  "I can't talk about who calls this line, but I can take a message for Owner.",
];

const GROK_EXACT = [
  "Oh nice.",
  "Ha, okay.",
  "Got it all. I'll make sure Owner hears it. Have a great one!",
  "Thank you, that means a lot. I'll make sure Owner gets your message.",
  "Take care.",
  "Good to hear from you.",
  "Thank you for calling.",
];

for (const line of [
  ...MESSAGE_EXACT,
  ...GROK_EXACT,
  "I am Owner's AI Bot.",
  "You can give freely to Owner on X at @ExampleOwner through X Money, a secure way to send money.",
]) {
  addLine(line);
  addLine(spokenGreeting(true, line));
}
{
  const catalog = loadGreetingCatalog();
  const lines = [...greetingLines(catalog), ...catalog.relatives, FALLBACK_GREETING];
  for (const line of lines) {
    addLine(line);
    addLine(spokenGreeting(true, line));
  }
}

function bareTime(word: string): string | null {
  if (TIME_WORDS.has(word)) return word;
  if (word.length > 4 && word.endsWith("es") && TIME_WORDS.has(word.slice(0, -2))) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && TIME_WORDS.has(word.slice(0, -1))) return word.slice(0, -1);
  return null;
}

function isTimeToken(word: string): boolean {
  if (/^\d{1,4}$/.test(word)) return true;
  const bare = bareTime(word);
  return bare !== null && bare !== "free";
}

function hasClock(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    if (!/^\d{1,2}$/.test(words[i] ?? "")) continue;
    const next = words[i + 1] ?? "";
    const after = words[i + 2] ?? "";
    if (next === "am" || next === "pm" || next === "oclock") return true;
    if ((next === "a" || next === "p") && after === "m") return true;
  }
  return false;
}

function hasRelationTime(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    if (!RELATION.has(words[i] ?? "")) continue;
    const end = Math.min(words.length, i + 4);
    for (let j = i + 1; j < end; j += 1) {
      if (isTimeToken(words[j] ?? "")) return true;
    }
  }
  return false;
}

/** "may" is a month only next to a date cue. "this call may be recorded" stays a verb. */
function mayIsDate(words: readonly string[], index: number): boolean {
  if (words[index] !== "may") return false;
  const prev = index > 0 ? (words[index - 1] ?? "") : "";
  const next = words[index + 1] ?? "";
  if (prev === "in" || prev === "on" || prev === "next" || prev === "last" || prev === "by") return true;
  return /^\d{1,2}$/.test(prev) || /^\d{1,2}$/.test(next);
}

export function hasTime(words: readonly string[]): boolean {
  let free = false;
  let other = false;
  for (let index = 0; index < words.length; index += 1) {
    if (mayIsDate(words, index)) {
      other = true;
      continue;
    }
    const bare = bareTime(words[index] ?? "");
    if (!bare) continue;
    if (bare === "free") free = true;
    else other = true;
  }
  if (hasClock(words) || hasRelationTime(words)) other = true;
  if (other || free) return true;
  return false;
}

function isCallerNumberAt(words: readonly string[], index: number): boolean {
  const next = words[index + 1] ?? "";
  if (next !== "the" && next !== "your") return false;
  const follow = words[index + 2] ?? "";
  return follow === "number" || follow === "callback" || follow === "phone";
}

export function hasPlace(words: readonly string[]): boolean {
  const key = words.join(" ");
  if (ADDRESS.test(key)) return true;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    const next = words[i + 1] ?? "";
    if (PLACE_NOUNS.has(word) || word === "nearby" || word === "whereabouts" || word === "whereabout") return true;
    if (word === "coffee" && next === "shop") return true;
    if (word === "meet" && (CATCH.has(next) || next === "at" || next === "by" || next === "near" || next === "in")) return true;
    if (word === "catch" && CATCH.has(next)) return true;
    if ((word === "lives" || word === "live" || word === "lived") && ["at", "in", "on", "near", "nearby", "by", "around"].includes(next)) {
      return true;
    }
    if (word === "at") {
      if (!next || AT_STOP.has(next) || isCallerNumberAt(words, i)) continue;
      return true;
    }
    if (word === "in") {
      if (!next || PRONOUN.has(next)) continue;
      if (PLACE_NOUNS.has(next)) return true;
      if (DET.has(next) && words[i + 2]) return true;
      continue;
    }
    if (word === "by" || word === "near" || word === "around") {
      if (DET.has(next) && words[i + 2]) return true;
      if (PLACE_NOUNS.has(next) || next === "nearby") return true;
    }
  }
  return false;
}

/** Ministry, website, and church talk is outside the four groups. */
export function hasClosedTopic(words: readonly string[]): boolean {
  return words.some((word) => CLOSED_TOPIC.has(word) || word.includes("exampleowner"));
}

const FAMILY_WORDS = new Set<string>([
  "mother", "mom", "mommy", "mum", "mummy", "mama", "ma",
  "father", "dad", "daddy", "papa",
  "parent", "brother", "sister", "sibling", "bro", "sis",
  "wife", "wives", "husband", "spouse",
  "kid", "child", "children", "daughter", "son",
  "niece", "nephew", "uncle", "aunt", "auntie", "aunty", "cousin",
  "grandma", "grandmother", "grandpa", "grandfather", "grandparent",
  "granny", "nana", "grandson", "granddaughter",
  "relative", "relation", "family", "folks", "folk",
  "stepmother", "stepfather", "stepson", "stepdaughter", "stepbrother", "stepsister",
  "stepmom", "stepdad", "godmother", "godfather", "godparent",
  "inlaw", "inlaws", "motherinlaw", "fatherinlaw", "brotherinlaw", "sisterinlaw",
  "soninlaw", "daughterinlaw", "parentinlaw",
]);

const PAY_WORDS = new Set<string>([
  "paid", "pay", "paying", "salary", "salaries", "wage", "wages", "earn",
  "earning", "earnings", "income", "money", "finances", "financial", "paycheck",
  "compensation", "compensate", "compensated",
]);

const HEALTH_WORDS = new Set<string>([
  "pregnant", "pregnancy", "sick", "sickness", "ill", "illness", "illnesses",
  "cancer", "cancers", "tumor", "tumors", "disease", "diseases", "diagnosis", "diagnosed",
  "surgery", "chemotherapy", "chemo", "medical", "doctor", "doctors",
  "stroke", "strokes", "symptom", "symptoms", "infection", "infections", "pain", "pains",
]);

const CONTACT_WORDS = new Set<string>(["email", "emails"]);

const CONTACT_PHRASES = [
  "e mail", "phone number", "phone numbers", "cell phone", "cell phones",
  "mobile number", "mobile numbers", "direct number", "direct numbers",
  "his cell", "her cell", "their cell", "owners cell", "cell directly",
  "cell number", "cell numbers",
];

function hasLexeme(words: readonly string[], set: ReadonlySet<string>): boolean {
  return words.some((word) => {
    if (set.has(word)) return true;
    if (word.endsWith("es") && set.has(word.slice(0, -2))) return true;
    if (word.endsWith("s") && set.has(word.slice(0, -1))) return true;
    return false;
  });
}

export function hasFamilyWord(words: readonly string[]): boolean {
  return hasLexeme(words, FAMILY_WORDS);
}

export function hasPayWord(words: readonly string[]): boolean {
  return hasLexeme(words, PAY_WORDS);
}

export function hasHealthWord(words: readonly string[]): boolean {
  return hasLexeme(words, HEALTH_WORDS);
}

export function hasContactWord(words: readonly string[]): boolean {
  return hasLexeme(words, CONTACT_WORDS);
}

export function hasContactPhrase(text: string): boolean {
  const padded = ` ${text} `;
  return CONTACT_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
}

function storedNameKey(knownName: string | null): string | null {
  if (!knownName) return null;
  const speech = normalizeSpeech(knownName);
  if (!speech.text || speech.sentences.length !== 1) return null;
  return speech.text;
}

/** hi / hello / hey plus this call's stored display name, and nothing else. */
export function isStoredNameHello(key: string, knownName: string | null): boolean {
  const name = storedNameKey(knownName);
  if (!name) return false;
  return key === `hi ${name}` || key === `hello ${name}` || key === `hey ${name}`;
}

/**
 * greetKnownCaller leads for this call's stored display name.
 * Calm is "Name, thank you for calling." Hyped starts with the name alone.
 */
export function isKnownCallerLead(key: string, knownName: string | null): boolean {
  const name = storedNameKey(knownName);
  if (!name) return false;
  return key === name || key === `${name} thank you for calling`;
}

/** Exact coded lines and whole-sentence greeting or closer patterns. */
export function isCodedOrGreeting(key: string): boolean {
  if (EXACT.has(key)) return true;
  if (GREETING_PATTERNS.some((pattern) => pattern.test(key))) return true;
  if (KNOWN_LEAD_PATTERNS.some((pattern) => pattern.test(key))) return true;
  return false;
}

export function isApprovedSentence(key: string, knownName: string | null = null): boolean {
  if (isCodedOrGreeting(key)) return true;
  if (isStoredNameHello(key, knownName)) return true;
  if (isKnownCallerLead(key, knownName)) return true;
  if (MESSAGE_QUESTIONS.some((pattern) => pattern.test(key))) return true;
  return false;
}
