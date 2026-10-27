import fs from "node:fs";
import path from "node:path";

import { easternCivilDate } from "./greeting.js";
import { logError } from "./logger.js";
import { redactSensitiveDigits } from "./redact.js";

/** Short admin note. Larger bodies are rejected before this is parsed. */
export const LIFE_CONTEXT_MAX_NOTE = 500;
export const LIFE_CONTEXT_MAX_BYTES = 4096;
const LIFE_CONTEXT_MAX_FILE_BYTES = 8192;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
/** Cc covers C0 and C1 controls, including U+0085. Zl and Zp are U+2028 and U+2029. */
const NOTE_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export interface LifeContext {
  note: string;
  allow_share: boolean;
  expires?: string;
}

export type LifeContextRead =
  | { ok: true; value: LifeContext }
  | { ok: false; reason: "absent" | "invalid" };

export function lifeContextPath(dataDir: string): string {
  return path.join(dataDir, "life-context.json");
}

function isRealCivilDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function isIsoTimestamp(value: string): boolean {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    return isRealCivilDay(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])) && !Number.isNaN(Date.parse(value));
  }
  const instant = INSTANT.exec(value);
  if (!instant) return false;
  const hour = Number(instant[4]);
  const minute = Number(instant[5]);
  const second = Number(instant[6]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (!isRealCivilDay(Number(instant[1]), Number(instant[2]), Number(instant[3]))) return false;
  return !Number.isNaN(Date.parse(value));
}

function storedShape(value: LifeContext): LifeContext {
  const note = redactSensitiveDigits(value.note).trim();
  if (value.expires !== undefined) {
    return { note, allow_share: value.allow_share, expires: value.expires };
  }
  return { note, allow_share: value.allow_share };
}

/** The 500-character cap applies to the note after digit redaction. */
function finalizedNote(value: LifeContext): LifeContext | null {
  if (NOTE_FORBIDDEN.test(value.note)) return null;
  const stored = storedShape(value);
  if (stored.note.length < 1 || stored.note.length > LIFE_CONTEXT_MAX_NOTE) return null;
  if (NOTE_FORBIDDEN.test(stored.note)) return null;
  return stored;
}

/** Accepts an admin JSON body. The note is digit-redacted before it is returned. */
export function parseLifeContextBody(raw: string): { ok: true; value: LifeContext } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "note" && key !== "allow_share" && key !== "expires") return { ok: false };
  }
  if (typeof record.note !== "string" || typeof record.allow_share !== "boolean") return { ok: false };
  if (NOTE_FORBIDDEN.test(record.note)) return { ok: false };
  const note = record.note.trim();
  if (note.length < 1 || note.length > LIFE_CONTEXT_MAX_NOTE) return { ok: false };
  let expires: string | undefined;
  if ("expires" in record) {
    if (typeof record.expires !== "string" || !isIsoTimestamp(record.expires)) return { ok: false };
    expires = record.expires;
  }
  const value = finalizedNote({ note, allow_share: record.allow_share, expires });
  if (!value) return { ok: false };
  return { ok: true, value };
}

function writeLifeFile(filePath: string, value: LifeContext): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(storedShape(value), null, 2)}\n`, { mode: 0o600 });
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

function asStored(value: unknown): LifeContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "note" && key !== "allow_share" && key !== "expires") return null;
  }
  if (typeof record.note !== "string" || typeof record.allow_share !== "boolean") return null;
  if (NOTE_FORBIDDEN.test(record.note)) return null;
  const note = record.note.trim();
  if (note.length < 1 || note.length > LIFE_CONTEXT_MAX_NOTE) return null;
  let expires: string | undefined;
  if ("expires" in record) {
    if (typeof record.expires !== "string" || !isIsoTimestamp(record.expires)) return null;
    expires = record.expires;
  }
  return finalizedNote({ note, allow_share: record.allow_share, expires });
}

export function readLifeContext(dataDir: string): LifeContextRead {
  const filePath = lifeContextPath(dataDir);
  if (!fs.existsSync(filePath)) return { ok: false, reason: "absent" };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > LIFE_CONTEXT_MAX_FILE_BYTES) return { ok: false, reason: "invalid" };
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const value = asStored(parsed);
    if (!value) return { ok: false, reason: "invalid" };
    if (value.note !== (parsed as { note?: string }).note) {
      try {
        writeLifeFile(filePath, value);
      } catch {
        logError("failed to rewrite life context");
      }
    }
    return { ok: true, value };
  } catch {
    logError("life context file was unreadable");
    return { ok: false, reason: "invalid" };
  }
}

export function writeLifeContext(dataDir: string, value: LifeContext): LifeContext {
  const stored = finalizedNote(value);
  if (!stored) throw new Error("invalid life context");
  writeLifeFile(lifeContextPath(dataDir), stored);
  return stored;
}

export function deleteLifeContext(dataDir: string): void {
  try {
    fs.unlinkSync(lifeContextPath(dataDir));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return;
    throw err;
  }
}

function easternDateKey(now: Date): number | null {
  try {
    const civil = easternCivilDate(now);
    return civil.year * 10_000 + civil.month * 100 + civil.day;
  } catch {
    return null;
  }
}

/**
 * An instant at or before `now` is ignored.
 * A YYYY-MM-DD value stays active through the end of that America/New_York civil day.
 * If that Eastern date cannot be resolved, the date-only note is treated as expired.
 */
export function activeLifeContext(dataDir: string, now: Date): LifeContext | null {
  const read = readLifeContext(dataDir);
  if (!read.ok) return null;
  if (read.value.expires !== undefined) {
    const dateOnly = DATE_ONLY.exec(read.value.expires);
    if (dateOnly) {
      const expiresKey = Number(dateOnly[1]) * 10_000 + Number(dateOnly[2]) * 100 + Number(dateOnly[3]);
      const today = easternDateKey(now);
      if (today === null || today > expiresKey) return null;
    } else {
      const expiresAt = Date.parse(read.value.expires);
      if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) return null;
    }
  }
  return read.value;
}
