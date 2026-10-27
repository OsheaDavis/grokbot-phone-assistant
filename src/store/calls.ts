import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logError } from "../logger.js";
import { redactNullablePhone, redactNullableText, redactStoredSummary } from "../redact.js";
import { normalizeFlags, normalizeQuestions } from "../summary/payload.js";
import { emptyMessage, type CallLogEntry, type Disposition } from "../types.js";

interface StoreFile {
  version: 1;
  calls: CallLogEntry[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isEntry(value: unknown): value is CallLogEntry {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.id !== "string" || typeof record.start_time !== "string") return false;
  if (typeof record.end_time !== "string" || typeof record.transcript_summary !== "string") return false;
  if (typeof record.disposition !== "string") return false;
  const message = asRecord(record.message);
  if (!message) return false;
  return true;
}

export function purgeCalls(calls: CallLogEntry[], nowMs: number, retentionDays: number): CallLogEntry[] {
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return calls.filter((call) => {
    const ended = Date.parse(call.end_time);
    if (Number.isNaN(ended)) return false;
    return ended >= cutoff;
  });
}

function readStore(filePath: string): StoreFile {
  if (!fs.existsSync(filePath)) return { version: 1, calls: [] };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const record = asRecord(parsed);
    if (!record || !Array.isArray(record.calls)) throw new Error("shape");
    return { version: 1, calls: record.calls.filter(isEntry) };
  } catch {
    const badPath = `${filePath}.bad-${Date.now()}`;
    try {
      fs.renameSync(filePath, badPath);
    } catch {
      /* leave the unreadable file in place if rename fails */
    }
    logError("call log was unreadable; started a new log");
    return { version: 1, calls: [] };
  }
}

function redactEntry(entry: CallLogEntry): CallLogEntry {
  return {
    ...entry,
    caller_number: redactNullablePhone(entry.caller_number),
    message: {
      name: redactNullableText(entry.message.name),
      callback_number: redactNullablePhone(entry.message.callback_number),
      reason: redactNullableText(entry.message.reason),
    },
    transcript_summary: redactStoredSummary(entry.transcript_summary),
    questions: normalizeQuestions(entry.questions),
  };
}

function writeStore(filePath: string, data: StoreFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* volume filesystems may reject chmod */
  }
}

export function buildDirectCallLog(opts: {
  callSid: string | null;
  callerNumber: string | null;
  flags: readonly string[];
  disposition: Exclude<Disposition, "connected">;
  summary: string;
  nowMs: number;
}): CallLogEntry {
  const iso = new Date(opts.nowMs).toISOString();
  return {
    id: crypto.randomUUID(),
    call_sid: opts.callSid,
    disposition: opts.disposition,
    caller_number: redactNullablePhone(opts.callerNumber),
    message: emptyMessage(),
    transcript_summary: redactStoredSummary(opts.summary),
    questions: [],
    start_time: iso,
    end_time: iso,
    flags: normalizeFlags(opts.flags),
  };
}

const TERMINAL_STATUSES = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export function isTerminalCallStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status);
}

/** Minimal log for a call Twilio reported but the server never saved. */
export function buildStatusCallLog(opts: {
  callSid: string;
  callerNumber: string | null;
  status: string;
  durationSec: number;
  nowMs: number;
}): CallLogEntry {
  const endMs = opts.nowMs;
  const startMs = endMs - opts.durationSec * 1000;
  return {
    id: crypto.randomUUID(),
    call_sid: opts.callSid,
    disposition: "status_only",
    caller_number: redactNullablePhone(opts.callerNumber),
    message: emptyMessage(),
    transcript_summary: redactStoredSummary(
      `Call ${opts.status}, ${opts.durationSec}s. No message or transcript was saved for this call.`,
    ),
    questions: [],
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(endMs).toISOString(),
    flags: [],
  };
}

export class CallStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly retentionDays: number,
  ) {}

  private enqueue<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async append(entry: CallLogEntry, nowMs = Date.now()): Promise<void> {
    await this.enqueue(() => {
      const data = readStore(this.filePath);
      const kept = purgeCalls(data.calls, nowMs, this.retentionDays);
      kept.push(redactEntry(entry));
      writeStore(this.filePath, { version: 1, calls: kept });
    });
  }

  async hasCallSid(callSid: string): Promise<boolean> {
    return this.enqueue(() => readStore(this.filePath).calls.some((call) => call.call_sid === callSid));
  }

  async readSince(since?: string, nowMs = Date.now()): Promise<CallLogEntry[]> {
    return this.enqueue(() => {
      const data = readStore(this.filePath);
      const kept = purgeCalls(data.calls, nowMs, this.retentionDays);
      if (kept.length !== data.calls.length) {
        writeStore(this.filePath, { version: 1, calls: kept });
      }
      const sinceMs = since === undefined ? undefined : Date.parse(since);
      const filtered = kept.filter((call) => {
        if (sinceMs === undefined || Number.isNaN(sinceMs)) return true;
        const ended = Date.parse(call.end_time);
        return !Number.isNaN(ended) && ended >= sinceMs;
      });
      return filtered.slice(-500);
    });
  }
}
