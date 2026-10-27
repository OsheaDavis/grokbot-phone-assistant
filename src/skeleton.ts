import { CONFUSABLE_ROWS } from "./confusables.js";
import { prepareDigitText } from "./redact.js";

/**
 * One normalizer for every question check, fact check, injection check, and
 * stored question. Order: NFKC and digit folding (prepareDigitText, which also
 * strips Cf), case-fold, NFD, strip Mn/Me/Cf plus fillers (U+2800, U+3164,
 * Hangul fillers, variation selectors), map confusables (U+02BC and U+2019
 * become an apostrophe), then collapse. A hyphen or a single dot between
 * letters is intra-word and is removed. A run of dots stays a word break.
 * Apostrophes are removed so "where's" stays one word. Whitespace collapses.
 */
const CONFUSABLES: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const line of CONFUSABLE_ROWS.trim().split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const ch = String.fromCodePoint(Number.parseInt(line.slice(0, space), 16));
    map.set(ch, line.slice(space + 1));
  }
  map.set("\u02BC", "'");
  map.set("\u2019", "'");
  return map;
})();

/** Marks, format chars, zero-width, variation selectors, and the fillers that split words. */
const STRIP = /[\p{Mn}\p{Me}\p{Cf}\u2800\u3164\u115F\u1160\uFFA0]/u;

const REDACTED = "[redacted]";

/** One character after case-fold and NFD. Marks drop out. Confusables become their prototype. */
export function mapSkeletonChar(ch: string): string {
  if (STRIP.test(ch)) return "";
  return CONFUSABLES.get(ch) ?? ch;
}

function hasNonAsciiLetter(text: string): boolean {
  for (const ch of text) {
    if (/\p{L}/u.test(ch) && (ch < "a" || ch > "z")) return true;
  }
  return false;
}

function isAz(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function lastTokenIsWord(out: string): boolean {
  if (!out || out.endsWith(" ")) return false;
  const space = out.lastIndexOf(" ");
  const token = space >= 0 ? out.slice(space + 1) : out;
  return token.length > 0 && [...token].every((ch) => isAz(ch));
}

function collapse(text: string): string {
  let out = "";
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; ) {
    if (chars.slice(i, i + REDACTED.length).join("") === REDACTED) {
      out += " [redacted] ";
      i += REDACTED.length;
      continue;
    }
    const ch = chars[i] ?? "";
    const next = chars[i + 1] ?? "";
    // One dot between letters is intra-word ("co.worker", "m.o.m"). An ellipsis stays a break.
    if (ch === "." && next !== "." && isAz(next) && lastTokenIsWord(out)) {
      i += 1;
      continue;
    }
    // A hyphen between letters joins ("grand-pa", "co-worker"). A hyphen in a phone number stays a break.
    if (/\p{Pd}/u.test(ch) && isAz(next) && lastTokenIsWord(out)) {
      i += 1;
      continue;
    }
    i += 1;
    if (isAz(ch) || (ch >= "0" && ch <= "9")) out += ch;
    else if (ch === "'" || ch === '"') continue;
    else out += " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

interface SkeletonScan {
  text: string;
  nonAsciiLetter: boolean;
}

function scan(input: string): SkeletonScan {
  const prepared = prepareDigitText(input).toLowerCase().normalize("NFD");
  let mapped = "";
  for (const ch of prepared) {
    if (STRIP.test(ch)) continue;
    mapped += CONFUSABLES.get(ch) ?? ch;
  }
  return { text: collapse(mapped), nonAsciiLetter: hasNonAsciiLetter(mapped) };
}

/** Skeleton used before a check and as the stored question text, before digit redaction. */
export function toSkeleton(input: string): string {
  return scan(input).text;
}

/** True when a letter is still outside a-z after the skeleton map. Marks and confusables do not count. */
export function skeletonHasNonAsciiLetter(input: string): boolean {
  return scan(input).nonAsciiLetter;
}
