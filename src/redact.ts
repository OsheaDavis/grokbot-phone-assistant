/**
 * Redacts caller-derived text before it is stored or sent.
 *
 * One normalization pass runs before the allowlist. Text is NFKC-normalized,
 * format characters (Cf, including zero-width spaces) are removed, and every
 * Unicode decimal digit, superscript, and circled digit is mapped to ASCII.
 * A digit run then joins across any run of non-letters. Spoken digit words
 * (zero, oh, o, one through nine) and double or triple X join across
 * punctuation and the fillers uh and um, including mixed words and numerals.
 * Double and triple expand first, so "triple five" is three digits.
 *
 * A run is kept only when it is a whole phone (10 digits, or 11 digits
 * starting with 1) written with phone separators or spoken as digit words,
 * or it has 1 or 2 digits. Colons, underscores, plus signs, and mixed words
 * and numerals are not a phone. A clock stays only when it is
 * h:mm or hh:mm followed by am/pm and it stands alone. A 4-digit year from
 * 1900 to 2099 stays when the next word is not a digit. Everything else is
 * [redacted]. A real word such as "and" still splits a run.
 *
 * caller_number and callback_number keep a valid NANP number, or an E.164
 * value that a phone library accepts. No phone library is installed, so
 * other E.164 values are dropped.
 */

const DIGIT_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** First code point of each Unicode decimal-digit block. Each block is ten Nd characters. */
const ND_ZERO = [
  0x0030, 0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6,
  0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40,
  0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0,
  0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50,
  0x11da0, 0x16a60, 0x16ac0, 0x16b50, 0x1e140, 0x1e2f0, 0x1e950, 0x1fbf0,
];

const CLOCK = /^(\d{1,2}):(\d{2})(?!\d)\s*(?:a\.?m\.?|p\.?m\.?)\b/i;

/** This project does not depend on a phone-number library. Non-NANP E.164 fails closed. */
const PHONE_LIBRARY_PRESENT = false;

function isAsciiDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

function isJoinerChar(ch: string): boolean {
  return ch !== "" && !isAsciiDigit(ch) && !isLetter(ch);
}

function decimalDigit(cp: number): string | null {
  for (const base of ND_ZERO) {
    if (cp >= base && cp < base + 10) return String(cp - base);
  }
  return null;
}

/** Circled digits that NFKC leaves unchanged. Values are the ASCII digits they stand for. */
function circledDigit(cp: number): string | null {
  if (cp === 0x24ff) return "0";
  if (cp >= 0x24eb && cp <= 0x24f4) return String(11 + (cp - 0x24eb));
  if (cp >= 0x24f5 && cp <= 0x24fd) return String(cp - 0x24f5 + 1);
  if (cp === 0x24fe) return "10";
  if (cp >= 0x2776 && cp <= 0x277e) return String(cp - 0x2776 + 1);
  if (cp === 0x277f) return "10";
  if (cp >= 0x2780 && cp <= 0x2788) return String(cp - 0x2780 + 1);
  if (cp === 0x2789) return "10";
  if (cp >= 0x278a && cp <= 0x2792) return String(cp - 0x278a + 1);
  if (cp === 0x2793) return "10";
  return null;
}

function mapNumericChar(ch: string): string {
  if (isAsciiDigit(ch)) return ch;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return ch;
  if (/\p{Nd}/u.test(ch)) {
    const digit = decimalDigit(cp);
    if (digit !== null) return digit;
  }
  const circled = circledDigit(cp);
  if (circled !== null) return circled;
  return ch;
}

/** NFKC, strip Cf, then map decimal, superscript, and circled digits to ASCII. */
export function prepareDigitText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKC")) {
    if (/\p{Cf}/u.test(ch)) continue;
    out += mapNumericChar(ch);
  }
  return out;
}

function readWord(chars: string[], index: number): { word: string; end: number } | null {
  const ch = chars[index] ?? "";
  if (!isLetter(ch)) return null;
  const prev = index > 0 ? (chars[index - 1] ?? "") : "";
  if (isLetter(prev)) return null;
  let end = index + 1;
  while (end < chars.length && isLetter(chars[end] ?? "")) end += 1;
  return { word: chars.slice(index, end).join("").toLowerCase(), end };
}

function skipJoiners(chars: string[], index: number): number {
  let j = index;
  while (j < chars.length) {
    const ch = chars[j] ?? "";
    if (isJoinerChar(ch)) {
      j += 1;
      continue;
    }
    if (isLetter(ch)) {
      const word = readWord(chars, j);
      if (word && (word.word === "uh" || word.word === "um")) {
        j = word.end;
        continue;
      }
    }
    break;
  }
  return j;
}

interface Atom {
  end: number;
  digits: string;
  kind: "num" | "word";
}

function readAtom(chars: string[], index: number): Atom | null {
  const ch = chars[index] ?? "";
  if (isAsciiDigit(ch)) {
    let end = index + 1;
    while (end < chars.length && isAsciiDigit(chars[end] ?? "")) end += 1;
    return { end, digits: chars.slice(index, end).join(""), kind: "num" };
  }
  const word = readWord(chars, index);
  if (!word) return null;
  if (word.word === "double" || word.word === "triple") {
    const repeats = word.word === "double" ? 2 : 3;
    const after = skipJoiners(chars, word.end);
    const op = chars[after] ?? "";
    if (isAsciiDigit(op)) {
      if (isAsciiDigit(chars[after + 1] ?? "")) return null;
      return { end: after + 1, digits: op.repeat(repeats), kind: "num" };
    }
    const spoken = readWord(chars, after);
    const digit = spoken ? DIGIT_WORDS[spoken.word] : undefined;
    if (spoken && digit) return { end: spoken.end, digits: digit.repeat(repeats), kind: "word" };
    return null;
  }
  const digit = DIGIT_WORDS[word.word];
  if (!digit) return null;
  return { end: word.end, digits: digit, kind: "word" };
}

function neighborDigit(chars: string[], index: number, dir: 1 | -1): boolean {
  let j = dir === 1 ? index : index - 1;
  while (j >= 0 && j < chars.length) {
    const ch = chars[j] ?? "";
    if (isAsciiDigit(ch)) return true;
    if (isLetter(ch)) {
      let start = j;
      let end = j + 1;
      while (start > 0 && isLetter(chars[start - 1] ?? "")) start -= 1;
      while (end < chars.length && isLetter(chars[end] ?? "")) end += 1;
      const word = chars.slice(start, end).join("").toLowerCase();
      if (word === "uh" || word === "um") {
        j = dir === 1 ? end : start - 1;
        continue;
      }
      return word in DIGIT_WORDS || word === "double" || word === "triple";
    }
    j += dir;
  }
  return false;
}

function matchStandaloneClock(chars: string[], index: number): number {
  if (!isAsciiDigit(chars[index] ?? "")) return 0;
  const found = CLOCK.exec(chars.slice(index).join(""));
  if (!found || found[1] === undefined || found[2] === undefined) return 0;
  const hour = Number(found[1]);
  const minute = Number(found[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return 0;
  const end = index + Array.from(found[0]).length;
  if (neighborDigit(chars, index, -1) || neighborDigit(chars, end, 1)) return 0;
  return end - index;
}

interface Run {
  end: number;
  digits: string;
}

function matchDigitRun(chars: string[], index: number): Run | null {
  let j = index;
  const ch = chars[j] ?? "";
  if (ch === "+" || ch === "(") {
    const prev = j > 0 ? (chars[j - 1] ?? "") : "";
    if (isLetter(prev) || isAsciiDigit(prev)) return null;
    let k = j + 1;
    while (k < chars.length && isJoinerChar(chars[k] ?? "")) k += 1;
    if (!readAtom(chars, k)) return null;
    j = k;
  }
  const first = readAtom(chars, j);
  if (!first) return null;
  let digits = first.digits;
  j = first.end;
  let prevKind = first.kind;
  while (j < chars.length) {
    const joined = skipJoiners(chars, j);
    const next = readAtom(chars, joined);
    if (!next) break;
    if (joined === j && next.kind === prevKind) break;
    digits += next.digits;
    j = next.end;
    prevKind = next.kind;
  }
  if (!digits || j <= index) return null;
  return { end: j, digits };
}

function isYear(digits: string): boolean {
  return /^(?:19|20)\d{2}$/.test(digits);
}

function nextWordIsDigit(after: string): boolean {
  let i = 0;
  while (i < after.length) {
    const ch = after[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "." || ch === "!" || ch === "?" || ch === "," || ch === ";" || ch === ":") {
      i += 1;
      continue;
    }
    break;
  }
  return isAsciiDigit(after[i] ?? "");
}

/** Spaces, commas, periods, dashes, slashes, and parentheses. Colon, underscore, and plus are not. */
function phoneSeparatorsOnly(span: string): boolean {
  if (!/\d/.test(span) || /\p{L}/u.test(span)) return false;
  const body = span.startsWith("+") ? span.slice(1) : span;
  return !body.includes("+") && /^[\d\s.,()/-]+$/.test(body);
}

/** A spoken phone is digit words, double or triple, and uh or um. No numerals mixed in. */
function spokenPhoneOnly(span: string): boolean {
  if (/\d/.test(span)) return false;
  const words = span.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return false;
  return words.every(
    (word) => word in DIGIT_WORDS || word === "double" || word === "triple" || word === "uh" || word === "um",
  );
}

/**
 * Phones, short counts, and standalone years stay. A 10-digit run, or 11 digits
 * starting with 1, is a phone only when the span is a numeric phone or a spoken
 * one. Colons, underscores, plus signs, and mixed words and numerals are not.
 */
function keepRun(digits: string, after: string, span: string): boolean {
  if (digits.length <= 2) return true;
  if (digits.length === 4 && isYear(digits) && !nextWordIsDigit(after)) return true;
  const phoneLength = digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  if (phoneLength && (phoneSeparatorsOnly(span) || spokenPhoneOnly(span))) return true;
  return false;
}

function scan(chars: string[], fold: boolean): string {
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const clock = matchStandaloneClock(chars, i);
    if (clock > 0) {
      out += chars.slice(i, i + clock).join("");
      i += clock;
      continue;
    }
    const run = matchDigitRun(chars, i);
    if (run) {
      if (fold) out += run.digits;
      else {
        const span = chars.slice(i, run.end).join("");
        const after = chars.slice(run.end).join("");
        out += keepRun(run.digits, after, span) ? span : "[redacted]";
      }
      i = run.end;
      continue;
    }
    out += chars[i] ?? "";
    i += 1;
  }
  return out;
}

function charsOf(text: string): string[] {
  return Array.from(prepareDigitText(text));
}

export function redactSensitiveDigits(text: string): string {
  return scan(charsOf(text), false);
}

/**
 * The same normalization the allowlist uses, collapsed to digit sequences so
 * a shorter snapshot of the same number compares as a prefix.
 */
export function foldDigitRuns(text: string): string {
  const canon = text
    .replaceAll("Owner's", "Owner's")
    .replaceAll("Owner", "Owner")
    .replaceAll("owner's", "owner's")
    .replaceAll("owner", "owner");
  return scan(charsOf(canon), true)
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Transcript summaries use the same allowlist before they are stored or sent. */
export function redactStoredSummary(text: string): string {
  return redactSensitiveDigits(text);
}

export function hasSensitiveNumber(text: string): boolean {
  const prepared = prepareDigitText(text);
  return redactSensitiveDigits(prepared) !== prepared;
}

function nationalNanp(digits: string, hasPlus: boolean): string | null {
  if (!hasPlus && digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

function e164PassesLibrary(): boolean {
  return PHONE_LIBRARY_PRESENT;
}

/**
 * A dedicated phone field. NANP is +1 and 10 digits, or 10 digits, and the
 * area code must not start with 0 or 1. Eleven digits starting with 1 are the
 * same +1 form. Any other E.164 value needs a phone library, which is absent.
 * The returned string is the normalized value, or null when it is not a phone.
 */
export function validatedPhone(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = prepareDigitText(value).trim();
  if (!normalized) return null;
  if (/\p{L}/u.test(normalized)) return null;
  const pluses = normalized.match(/\+/g);
  if (pluses && (pluses.length > 1 || !normalized.startsWith("+"))) return null;
  const digits = normalized.replace(/\D/g, "");
  const national = nationalNanp(digits, normalized.startsWith("+"));
  const area = national?.[0] ?? "";
  if (national && area >= "2" && area <= "9") return normalized;
  if (normalized.startsWith("+") && digits.length >= 8 && digits.length <= 15 && e164PassesLibrary()) {
    return normalized;
  }
  return null;
}

export function redactPhoneField(value: string): string | null {
  return validatedPhone(value);
}

export function redactNullableText(value: string | null): string | null {
  if (value === null) return null;
  return redactSensitiveDigits(value);
}

export function redactNullablePhone(value: string | null): string | null {
  if (value === null) return null;
  return validatedPhone(value);
}

function isSeparatorChar(ch: string): boolean {
  return ch !== "" && !isAsciiDigit(ch) && !/[A-Za-z]/.test(ch);
}

/**
 * Drop a digit run left on the end of a clipped fallback reason.
 * The cut can land in the middle of a number, so the tail is removed even
 * when the remaining digits would otherwise be short enough to keep.
 */
export function trimPartialDigitRun(text: string): string {
  const trimmed = text.trimEnd();
  let i = trimmed.length;
  while (i > 0 && isSeparatorChar(trimmed[i - 1] ?? "")) i -= 1;
  if (i === 0 || !isAsciiDigit(trimmed[i - 1] ?? "")) return trimmed.trim();
  while (i > 0) {
    const ch = trimmed[i - 1] ?? "";
    if (isAsciiDigit(ch)) {
      i -= 1;
      continue;
    }
    if (ch === "x" || ch === "X") {
      const prev = trimmed[i - 2] ?? "";
      if (isAsciiDigit(prev) || isSeparatorChar(prev)) {
        i -= 1;
        continue;
      }
      break;
    }
    if (ch === "+" || ch === "(") {
      i -= 1;
      continue;
    }
    if (isSeparatorChar(ch)) {
      let k = i - 1;
      while (k > 0 && isSeparatorChar(trimmed[k - 1] ?? "")) k -= 1;
      const prev = k > 0 ? (trimmed[k - 1] ?? "") : "";
      if (isAsciiDigit(prev) || prev === "x" || prev === "X" || prev === "+" || prev === "(") {
        i -= 1;
        continue;
      }
      break;
    }
    break;
  }
  return trimmed.slice(0, i).trimEnd();
}

/** Auto-summary reasons use the same allowlist as every other stored caller field. */
export function redactFallbackExcerpt(text: string): string {
  return redactSensitiveDigits(text);
}
