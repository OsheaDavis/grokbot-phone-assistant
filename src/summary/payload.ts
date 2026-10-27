import { redactNullablePhone, redactNullableText, redactStoredSummary, trimPartialDigitRun } from "../redact.js";
import { toSkeleton } from "../skeleton.js";
import {
  KNOWN_FLAGS,
  type CallFlag,
  type CallLogEntry,
  type CallQuestion,
  type CallSummary,
} from "../types.js";

export const MAX_SUMMARY_QUESTIONS = 20;
export const QUESTION_TEXT_MAX = 200;

const SUMMARY_KEYS = [
  "caller_number",
  "name",
  "callback_number",
  "reason",
  "transcript_summary",
  "questions",
  "start_time",
  "end_time",
  "flags",
  "urgent",
] as const;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function normalizeFlags(flags: readonly string[]): CallFlag[] {
  const present = new Set<string>(flags);
  return KNOWN_FLAGS.filter((flag) => present.has(flag));
}

export function isIso8601(value: string): boolean {
  return ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

/** possible_scam wins. The boolean and the flag stay in agreement. */
export function canonicalizeSummary(summary: CallSummary): CallSummary {
  const scam = summary.flags.includes("possible_scam");
  const want = summary.urgent === true && !scam;
  const base = summary.flags.filter((flag) => flag !== "urgent");
  const flags = normalizeFlags(want ? [...base, "urgent"] : base);
  return {
    caller_number: summary.caller_number,
    name: summary.name,
    callback_number: summary.callback_number,
    reason: summary.reason,
    transcript_summary: summary.transcript_summary,
    questions: normalizeQuestions(summary.questions),
    start_time: summary.start_time,
    end_time: summary.end_time,
    flags,
    urgent: flags.includes("urgent"),
  };
}

export function summaryFromLog(entry: CallLogEntry): CallSummary {
  const flagged = entry.flags.includes("urgent") && !entry.flags.includes("possible_scam");
  return canonicalizeSummary({
    caller_number: redactNullablePhone(entry.caller_number),
    name: redactNullableText(entry.message.name),
    callback_number: redactNullablePhone(entry.message.callback_number),
    reason: redactNullableText(entry.message.reason),
    transcript_summary: redactStoredSummary(entry.transcript_summary),
    questions: normalizeQuestions(entry.questions),
    start_time: entry.start_time,
    end_time: entry.end_time,
    flags: entry.flags,
    urgent: flagged,
  });
}

export function serializeSummary(summary: CallSummary): string {
  const canonical = canonicalizeSummary(summary);
  const body: CallSummary = {
    caller_number: redactNullablePhone(canonical.caller_number),
    name: redactNullableText(canonical.name),
    callback_number: redactNullablePhone(canonical.callback_number),
    reason: redactNullableText(canonical.reason),
    transcript_summary: redactStoredSummary(canonical.transcript_summary),
    questions: normalizeQuestions(canonical.questions),
    start_time: canonical.start_time,
    end_time: canonical.end_time,
    flags: canonical.flags,
    urgent: canonical.urgent,
  };
  return JSON.stringify(body);
}

function questionShapeError(value: unknown): string | null {
  if (!Array.isArray(value)) return "questions must be an array";
  if (value.length > MAX_SUMMARY_QUESTIONS) return "too many questions";
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "question must be an object";
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes("question") || !keys.includes("answered")) return "unexpected question field";
    if (typeof record.question !== "string" || record.question.length < 1) return "question text must be a string";
    if (record.question.length > QUESTION_TEXT_MAX) return "question text is too long";
    if (typeof record.answered !== "boolean") return "answered must be a boolean";
  }
  return null;
}

/** Redacts question text and keeps at most 20. Invalid items are dropped. */
export function normalizeQuestions(value: readonly CallQuestion[] | null | undefined): CallQuestion[] {
  if (!value || !Array.isArray(value)) return [];
  const out: CallQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item.question !== "string" || typeof item.answered !== "boolean") continue;
    const flat = toSkeleton(item.question);
    if (!flat) continue;
    let question = redactStoredSummary(flat);
    if (question.length > QUESTION_TEXT_MAX) {
      question = redactStoredSummary(trimPartialDigitRun(question.slice(0, QUESTION_TEXT_MAX))).trim();
    }
    if (!question || question.length > QUESTION_TEXT_MAX) continue;
    out.push({ question, answered: item.answered });
    if (out.length >= MAX_SUMMARY_QUESTIONS) break;
  }
  return out;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Returns null when the value matches the desk summary contract. */
export function summaryShapeError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "summary must be an object";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of SUMMARY_KEYS) {
    if (!keys.includes(key)) return `missing ${key}`;
  }
  for (const key of keys) {
    if (!SUMMARY_KEYS.includes(key as (typeof SUMMARY_KEYS)[number])) return `unexpected ${key}`;
  }
  if (!isNullableString(record.caller_number)) return "caller_number must be a string or null";
  if (!isNullableString(record.name)) return "name must be a string or null";
  if (!isNullableString(record.callback_number)) return "callback_number must be a string or null";
  if (!isNullableString(record.reason)) return "reason must be a string or null";
  if (typeof record.transcript_summary !== "string") return "transcript_summary must be a string";
  const questions = questionShapeError(record.questions);
  if (questions) return questions;
  if (typeof record.start_time !== "string" || !isIso8601(record.start_time)) return "start_time must be ISO 8601";
  if (typeof record.end_time !== "string" || !isIso8601(record.end_time)) return "end_time must be ISO 8601";
  if (!Array.isArray(record.flags)) return "flags must be an array";
  const seen = new Set<string>();
  for (const flag of record.flags) {
    if (typeof flag !== "string" || !(KNOWN_FLAGS as readonly string[]).includes(flag)) return "unknown flag";
    if (seen.has(flag)) return "duplicate flag";
    seen.add(flag);
  }
  if (typeof record.urgent !== "boolean") return "urgent must be a boolean";
  const scam = seen.has("possible_scam");
  const marked = seen.has("urgent");
  if (scam && (marked || record.urgent === true)) return "possible_scam overrides urgent";
  if (record.urgent !== marked) return record.urgent ? "urgent flag missing" : "urgent flag set";
  return null;
}

export interface TranscriptLine {
  role: "caller" | "assistant";
  text: string;
}

export function buildTranscriptSummary(lines: TranscriptLine[], maxLen = 1500): string {
  const text = lines
    .map((line) => `${line.role === "caller" ? "Caller" : "Assistant"}: ${line.text}`)
    .join("\n")
    .trim();
  if (!text) return "No transcript captured.";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}
