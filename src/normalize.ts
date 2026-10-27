import { mapSkeletonChar } from "./skeleton.js";
import { prepareDigitText } from "./redact.js";

/**
 * One word stream for every safety check. NFKC, digit folding, and confusables
 * match the skeleton. Hyphen, dot, underscore, slash, and the other join marks
 * become word breaks, so "at-the-hospital" is at the hospital.
 * A dot before an uppercase letter, or a dot with space after it, ends a
 * sentence: "nearby.His" and "hospital.See" are two sentences. "exampleowner.org"
 * stays one website token, "exampleownerorg".
 */
const GLUE = new Set(["'", "\u2019", "\u2018", "\u02BC"]);
const REDACTED = "[redacted]";

export interface NormalizedSpeech {
  sentences: string[][];
  words: string[];
  text: string;
}

function isSpace(ch: string): boolean {
  return /\s/u.test(ch) || /\p{Z}/u.test(ch);
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLowerLetter(ch: string): boolean {
  return /\p{Ll}/u.test(ch);
}

function foldWord(raw: string): string {
  let out = "";
  for (const ch of raw.toLowerCase().normalize("NFD")) out += mapSkeletonChar(ch);
  return out.replace(/['"]/g, "");
}

function collapseWebsite(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word === "exampleowner" && words[i + 1] === "org") {
      out.push("exampleownerorg");
      i += 1;
      continue;
    }
    if (word) out.push(word);
  }
  return out;
}

interface Look {
  gap: boolean;
  next: string;
}

function lookAfter(chars: string[], index: number): Look {
  let gap = false;
  for (let j = index; j < chars.length; j += 1) {
    const ch = chars[j] ?? "";
    if (ch === "\u2800" || ch === "\u3164" || ch === "\u115F" || ch === "\u1160" || ch === "\uFFA0") continue;
    if (/\p{M}/u.test(ch)) continue;
    if (isSpace(ch)) {
      gap = true;
      continue;
    }
    return { gap, next: ch };
  }
  return { gap, next: "" };
}

export function normalizeSpeech(input: string, opts?: { final?: boolean }): NormalizedSpeech {
  const final = opts?.final !== false;
  const chars = Array.from(prepareDigitText(input));
  const sentences: string[][] = [[]];
  let buf = "";
  let open = false;

  const closeWord = (): void => {
    const folded = foldWord(buf);
    buf = "";
    open = false;
    if (folded) sentences[sentences.length - 1]?.push(folded);
  };

  const closeSentence = (): void => {
    closeWord();
    sentences.push([]);
  };

  for (let i = 0; i < chars.length; i += 1) {
    if (chars.slice(i, i + REDACTED.length).join("") === REDACTED) {
      closeWord();
      sentences[sentences.length - 1]?.push("redacted");
      i += REDACTED.length - 1;
      continue;
    }
    const ch = chars[i] ?? "";
    if (ch === "\u2800" || ch === "\u3164" || ch === "\u115F" || ch === "\u1160" || ch === "\uFFA0" || /\p{M}/u.test(ch)) {
      continue;
    }
    if (GLUE.has(ch)) continue;
    if (ch === "\n" || ch === "\r" || /\p{Zl}|\p{Zp}/u.test(ch)) {
      closeSentence();
      continue;
    }
    if (isSpace(ch)) {
      closeWord();
      continue;
    }
    if (ch === "." || ch === "!" || ch === "?" || ch === "\u3002") {
      const look = lookAfter(chars, i + 1);
      const prevDigit = buf.length > 0 && isDigit(buf[buf.length - 1] ?? "");
      const intraDot =
        ch === "." &&
        !look.gap &&
        ((isLowerLetter(look.next) && !prevDigit) || (prevDigit && isDigit(look.next)));
      if (intraDot) {
        closeWord();
        continue;
      }
      closeSentence();
      continue;
    }
    if (ch === ";") {
      closeSentence();
      continue;
    }
    if (isLetter(ch) || isDigit(ch)) {
      buf += ch;
      open = true;
      continue;
    }
    // Hyphen, underscore, slash, comma, and the other join marks are word breaks.
    closeWord();
  }

  if (final || !open) closeWord();
  else {
    buf = "";
    open = false;
  }

  const kept = sentences.map((sentence) => collapseWebsite(sentence)).filter((sentence) => sentence.length > 0);
  const words = kept.flat();
  return { sentences: kept, words, text: words.join(" ") };
}
