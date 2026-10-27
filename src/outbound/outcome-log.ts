import fs from "node:fs";
import path from "node:path";

import type { CallSummary } from "../types.js";
import type { OutcomeRecord } from "./turn.js";

const TYPE_RE = /^[a-z0-9_-]{1,32}$/;

function safeType(type: string): string {
  return TYPE_RE.test(type) ? type : "unknown";
}

export interface LoggedOutcome extends OutcomeRecord {
  endedAt: string;
  durationSec: number;
  callStatus: string;
}

/** Appends one line per call to <dataDir>/call-logs/outbound/<type>.jsonl. Labels and fixed captures only. */
export function appendOutcome(dataDir: string, rec: LoggedOutcome): string {
  const dir = path.join(dataDir, "call-logs", "outbound");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeType(rec.type)}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  return file;
}

export function readOutcomes(dataDir: string, type: string): LoggedOutcome[] {
  const file = path.join(dataDir, "call-logs", "outbound", `${safeType(type)}.jsonl`);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: LoggedOutcome[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoggedOutcome);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Proposals from the outcome history. Pure; it reads nothing and writes nothing. */
export function proposeLessons(rows: readonly LoggedOutcome[]): string[] {
  const n = rows.length;
  if (n === 0) return [];
  const count = (o: string): number => rows.filter((r) => r.outcome === o).length;
  const out: string[] = [];
  const unclear = count("unclear");
  if (unclear / n >= 0.3) out.push(`${unclear}/${n} calls ended unclear. Consider a shorter, plainer question line.`);
  const refused = count("refused");
  if (refused > 0) out.push(`${refused}/${n} calls hit an off-card topic. Review whether the refusal was right; do not widen the card without Owner's yes.`);
  const declined = count("declined");
  if (declined > 0) out.push(`${declined}/${n} callees declined to talk to an AI. Consider whether this call type should be made by a person.`);
  const vm = count("voicemail") + count("no_answer");
  if (vm / n >= 0.5) out.push(`${vm}/${n} calls reached voicemail or no answer. Consider a different time of day.`);
  const yesNoItem = rows.filter((r) => r.outcome === "yes" && !r.item).length;
  if (yesNoItem > 0) out.push(`${yesNoItem} yes answers had no item type. Consider rewording the follow-up line.`);
  const cardRefused = count("card_refused");
  if (cardRefused > 0) out.push(`${cardRefused} calls ended on a card check (missing or changed card). Investigate before the next call.`);
  return out;
}

/**
 * Writes <dataDir>/call-lessons/<type>.md. PROPOSALS ONLY: this never touches
 * call-cards/. Any script change is a new card version that needs Owner's yes.
 */
export function writeLessons(dataDir: string, type: string, nowIso: string): { file: string; lessons: string[] } {
  const rows = readOutcomes(dataDir, type);
  const dir = path.join(dataDir, "call-lessons");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${safeType(type)}.md`);
  const lessons = proposeLessons(rows);
  const body = [
    `# Lessons (proposals only): ${safeType(type)}`,
    `Updated ${nowIso}. ${rows.length} calls logged.`,
    "These are proposals. They never change a card or script automatically; a change needs a new card version and Owner's yes.",
    "",
    ...(lessons.length ? lessons.map((l) => `- ${l}`) : ["- No proposals yet."]),
    "",
  ].join("\n");
  fs.writeFileSync(file, body, { mode: 0o600 });
  return { file, lessons };
}

/**
 * Summary for the webhook (Phone bot routine). No callee number, no
 * transcript. The desk summary contract has fixed keys, so the structured
 * answers ride in transcript_summary as labelled fields, always present:
 * Result, Item (car/keys/both/unknown), Pickup (fixed time phrases or unknown),
 * and Lessons (proposals only; nothing is changed automatically).
 */
export function outboundSummary(rec: LoggedOutcome, nowMs: number, lessons: readonly string[] = []): CallSummary {
  const parts = [
    `Outbound ${rec.type} call to ${rec.calleeName} (card ${rec.cardId}, hash ${rec.cardHash.slice(0, 12)}).`,
    `Result: ${rec.outcome}.`,
    `Item: ${rec.item ?? "unknown"}.`,
    `Pickup: ${rec.pickup ?? "unknown"}.`,
    rec.refusal ? `Ended by rule: ${rec.refusal}.` : "",
    `Turns: ${rec.turns}. Duration: ${rec.durationSec} s. Twilio status: ${rec.callStatus}.`,
    `Lessons (proposals only, nothing changed): ${lessons.length ? lessons.join(" | ") : "none"}.`,
  ].filter(Boolean);
  const end = new Date(nowMs).toISOString();
  const start = rec.startedAtMs ? new Date(rec.startedAtMs).toISOString() : new Date(nowMs - rec.durationSec * 1000).toISOString();
  return {
    caller_number: null,
    name: rec.calleeName,
    callback_number: null,
    reason: `Outbound returns check: ${rec.outcome}`,
    transcript_summary: parts.join(" "),
    questions: [],
    start_time: start,
    end_time: end,
    flags: [],
    urgent: false,
  };
}
