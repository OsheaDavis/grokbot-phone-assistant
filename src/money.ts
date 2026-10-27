import { hasSensitiveNumber } from "./redact.js";
import { toSkeleton } from "./skeleton.js";

/**
 * Summary flags. money_related is a money phrase. possible_scam is set for
 * every money_related call, and also for a scam pattern or card, bank, or
 * routing digits in free text. Phrase lists are documented in
 * docs/handoff/summary-schema.md.
 */

const AMOUNT =
  "a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|couple|few|\\d+";

const CENT_AMOUNT =
  "a|an|one|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|couple|few|\\d+";

const MONEY_PATTERNS: RegExp[] = [
  /\bpay(?:ments?|ing|s)?\b/i,
  /\bsend(?:ing)?\s+money\b/i,
  /\bwir(?:e|ed|es|ing)\b/i,
  /\bgift[\s-]*cards?\b/i,
  /\bbitcoins?\b/i,
  /\bcrypto(?:currency)?\b/i,
  /\bvenmo\b/i,
  /\bzelle\b/i,
  /\bcash[\s-]*app\b/i,
  /\bpaypal\b/i,
  /\bbanks?\b/i,
  /\baccount\s*(?:number|no\.?|#)\b/i,
  /\bcard\s*(?:number|no\.?|#)\b/i,
  /\brouting\b/i,
  /\binvoices?\b/i,
  /\brefunds?\b/i,
  /\bowe[sd]?\b/i,
  /\bloans?\b/i,
  /\bdonat(?:e|es|ed|ion|ions|ing)\b/i,
  /\bx[-\s]?money\b/i,
  // An amount word before dollar or buck. "Buck" alone is a name.
  new RegExp(`\\b(?:${AMOUNT})[\\s-]+bucks?\\b`, "i"),
  new RegExp(`\\b(?:${AMOUNT})[\\s-]+dollars?\\b`, "i"),
  // "two cents" is the opinion idiom. Other amounts still count.
  new RegExp(`\\b(?:${CENT_AMOUNT})[\\s-]+cents?\\b`, "i"),
  // cash counts next to a money verb, not in "Cash is calling."
  /\b(?:sends?|sending|sent|pays?|paying|paid|gives?|giving|gave|given|wires?|wiring|wired|owes?|owing|owed)\b(?:\s+\w+){0,4}\s+cash\b/i,
  /\b(?:apple|google|samsung)[\s-]*pay\b/i,
  /\bmoney\s*grams?\b/i,
  /\bwestern union\b/i,
];

const URGENCY =
  /\b(?:urgent(?:ly)?|immediately|right now|asap|as soon as possible|suspended|warrant|arrest(?:ed)?|lawsuit|final notice|act now|expires?|last chance|within the hour)\b/i;

const SCAM_PATTERNS: RegExp[] = [
  /\bgift[\s-]*cards?\b/i,
  /\b(?:bitcoin|btc|ethereum|crypto(?:currency)?|usdt)\b/i,
  /\bverify (?:your|the) account\b/i,
  /\b(?:verification|security|one[-\s]?time|confirmation|authentication|2fa|pass)[\s-]*codes?\b/i,
  /\b(?:otp|passcode)\b/i,
  /\b(?:read|tell|give|text)(?: me| us)? the (?:code|pin)\b/i,
  /\b(?:irs|fbi|cia|ssa|dmv|medicare)\b/i,
  /\bsocial security\b/i,
  /\b(?:this is|i am|i'm|we're|we are|calling from)\b(?:\s+\w+){0,4}\s+(?:the\s+)?(?:bank|irs|government|police|sheriff|fbi|medicare)\b/i,
  /\b(?:your bank|bank fraud|fraud department)\b/i,
  /\bdepartment of (?:the )?(?:treasury|justice|revenue)\b/i,
];

function anyPattern(text: string, patterns: readonly RegExp[]): boolean {
  const skeleton = toSkeleton(text);
  return patterns.some((pattern) => pattern.test(text) || (skeleton !== text && pattern.test(skeleton)));
}

export function mentionsMoney(text: string): boolean {
  return anyPattern(text, MONEY_PATTERNS);
}

/** Scam wording, not digit detection. Digit detection is hasSensitiveNumber. */
export function scamPhrases(text: string): boolean {
  if (anyPattern(text, SCAM_PATTERNS)) return true;
  return anyPattern(text, [URGENCY]) && mentionsMoney(text);
}

export function looksLikeScam(text: string): boolean {
  return scamPhrases(text) || hasSensitiveNumber(text);
}

const SALES_PATTERNS: RegExp[] = [
  /\bsales?\s+(?:call|rep|pitch|department|person)\b/i,
  /\b(?:telemarketer|soliciting)\b/i,
  /\blimited[- ]time offer\b/i,
];

/** A sales pitch is not urgent. It is not, by itself, marked possible_scam. */
export function looksLikeSales(text: string): boolean {
  return anyPattern(text, SALES_PATTERNS);
}
