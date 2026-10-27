import fs from "node:fs";
import path from "node:path";

import { looksLikeInjection } from "./injection.js";
import { logError } from "./logger.js";
import { redactSensitiveDigits } from "./redact.js";
import { skeletonHasNonAsciiLetter, toSkeleton } from "./skeleton.js";

/** Admin JSON body cap. The on-disk file may be a little larger after pretty-printing. */
export const APPROVED_FACTS_MAX_BYTES = 12_288;
const APPROVED_FACTS_MAX_FILE_BYTES = 16_384;

export const APPROVED_FACTS_MAX = 20;
/** Topic and answer are each one line. The answer cap is the caller's limit. */
export const APPROVED_FACT_MAX_TOPIC = 200;
export const APPROVED_FACT_MAX_ANSWER = 200;

/** Cc, Zl, Zp, Cf, Mn, and Me. Invisible marks are not stored in the prompt. */
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Mn}\p{Me}]/u;

/**
 * Section and closer words. "approved" plus "fact" or "facts" matches in either
 * order, with any other words between them. Punctuation is already gone.
 */
const SECTION_WORDS = new Set<string>([
  "end",
  "system",
  "assistant",
  "instruction",
  "instructions",
  "rule",
  "rules",
  "prompt",
  "prompts",
  "ignore",
  "disregard",
  "forget",
  "override",
]);

/** Joined with hyphens or dots, these still close a section. Short words like "end" are not substrings. */
const COMPACT_CLOSERS = ["approvedfact", "ignore", "disregard", "forget", "override", "instruction", "prompt", "jailbreak"];

function sectionCloser(skeleton: string): boolean {
  const words = new Set(skeleton.split(" ").filter((word) => word.length > 0));
  for (const word of SECTION_WORDS) {
    if (words.has(word)) return true;
  }
  if (words.has("approved") && (words.has("fact") || words.has("facts"))) return true;
  const compact = skeleton.replace(/ /g, "");
  return COMPACT_CLOSERS.some((needle) => compact.includes(needle));
}

/** Skeleton check: closer words, a leftover non-ASCII letter, or an injection phrase. */
function rejectedFactText(value: string): boolean {
  if (skeletonHasNonAsciiLetter(value)) return true;
  const skeleton = toSkeleton(value);
  if (!skeleton) return true;
  if (sectionCloser(skeleton)) return true;
  return looksLikeInjection(value);
}

export interface ApprovedFact {
  topic: string;
  answer: string;
}

export interface ApprovedFacts {
  facts: ApprovedFact[];
}

export type ApprovedFactsRead =
  | { ok: true; value: ApprovedFacts }
  | { ok: false; reason: "absent" | "invalid" };

export function approvedFactsPath(dataDir: string): string {
  return path.join(dataDir, "approved-facts.json");
}

function instructionLike(value: string): boolean {
  return rejectedFactText(value);
}

/**
 * One line, within max, with digits redacted.
 * A callback-style phone number stays. Anything else sensitive becomes [redacted].
 * Instruction-like text is rejected instead of stored.
 */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (FORBIDDEN.test(value)) return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) return null;
  if (FORBIDDEN.test(trimmed) || instructionLike(trimmed)) return null;
  const redacted = redactSensitiveDigits(trimmed);
  if (redacted.length < 1 || redacted.length > max) return null;
  if (FORBIDDEN.test(redacted) || instructionLike(redacted)) return null;
  return redacted;
}

function asFact(value: unknown, seen: Set<string>): ApprovedFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "topic" && key !== "answer") return null;
  }
  const topic = oneLine(record.topic, APPROVED_FACT_MAX_TOPIC);
  const answer = oneLine(record.answer, APPROVED_FACT_MAX_ANSWER);
  if (!topic || !answer) return null;
  const key = toSkeleton(topic);
  if (!key || seen.has(key)) return null;
  seen.add(key);
  return { topic, answer };
}

function asStored(value: unknown): ApprovedFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "facts") return null;
  }
  if (!Array.isArray(record.facts) || record.facts.length > APPROVED_FACTS_MAX) return null;
  const seen = new Set<string>();
  const facts: ApprovedFact[] = [];
  for (const entry of record.facts) {
    const fact = asFact(entry, seen);
    if (!fact) return null;
    facts.push(fact);
  }
  return { facts };
}

/** Drops invalid facts. The admin write path rejects the whole body instead. */
export function usableApprovedFacts(value: readonly ApprovedFact[] | null | undefined): ApprovedFact[] {
  if (!value || !Array.isArray(value)) return [];
  const seen = new Set<string>();
  const facts: ApprovedFact[] = [];
  for (const entry of value) {
    if (facts.length >= APPROVED_FACTS_MAX) break;
    const fact = asFact(entry, seen);
    if (fact) facts.push(fact);
  }
  return facts;
}

function writeApprovedFile(filePath: string, value: ApprovedFacts): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file was already moved or was never created */
    }
    throw err;
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* volume filesystems may reject chmod */
  }
}

/** Accepts an admin JSON body. Topic and answer are digit-redacted before they are returned. */
export function parseApprovedFactsBody(raw: string): { ok: true; value: ApprovedFacts } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const value = asStored(parsed);
  if (!value) return { ok: false };
  return { ok: true, value };
}

export function readApprovedFacts(dataDir: string): ApprovedFactsRead {
  const filePath = approvedFactsPath(dataDir);
  if (!fs.existsSync(filePath)) return { ok: false, reason: "absent" };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > APPROVED_FACTS_MAX_FILE_BYTES) return { ok: false, reason: "invalid" };
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const value = asStored(parsed);
    if (!value) return { ok: false, reason: "invalid" };
    if (JSON.stringify(parsed) !== JSON.stringify(value)) {
      try {
        writeApprovedFile(filePath, value);
      } catch {
        logError("failed to rewrite approved facts");
      }
    }
    return { ok: true, value };
  } catch {
    logError("approved facts file was unreadable");
    return { ok: false, reason: "invalid" };
  }
}

export function writeApprovedFacts(dataDir: string, value: ApprovedFacts): ApprovedFacts {
  const stored = asStored(value);
  if (!stored) throw new Error("invalid approved facts");
  writeApprovedFile(approvedFactsPath(dataDir), stored);
  return stored;
}

export function deleteApprovedFacts(dataDir: string): void {
  try {
    fs.unlinkSync(approvedFactsPath(dataDir));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return;
    throw err;
  }
}
