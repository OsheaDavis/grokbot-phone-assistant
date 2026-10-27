import fs from "node:fs";
import path from "node:path";

import { logError } from "./logger.js";
import { normalizeCallerNumber, samePhone } from "./phone.js";
import { redactSensitiveDigits, validatedPhone } from "./redact.js";

/** Admin JSON body cap. The on-disk file may be a little larger after pretty-printing. */
export const KNOWN_PEOPLE_MAX_BYTES = 12_288;
const KNOWN_PEOPLE_MAX_FILE_BYTES = 16_384;
const MAX_PEOPLE = 32;
const MAX_PHONES = 5;

/** One line. Letters, spaces, apostrophe, hyphen, and period only. */
export const KNOWN_LABEL_MAX = 40;

/** Cc, Zl, Zp, and Cf. Checked on the raw label, before trim. */
const LABEL_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u;
const LABEL_ALLOWED = /^[\p{L} .'\-]+$/u;

export interface KnownPerson {
  name: string;
  relation: string;
  phones: string[];
}

export interface KnownPeople {
  people: KnownPerson[];
}

export type KnownPeopleRead =
  | { ok: true; value: KnownPeople }
  | { ok: false; reason: "absent" | "invalid" };

export function knownPeoplePath(dataDir: string): string {
  return path.join(dataDir, "known-people.json");
}

/**
 * A name or relation Owner stored.
 * One line, at most 40 characters, letters (any script), spaces, and ' - . only.
 * A label that digit redaction would change is rejected instead of rewritten.
 */
function trimSpaces(value: string): string {
  return value.replace(/^[ ]+|[ ]+$/g, "");
}

export function knownPersonLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (LABEL_FORBIDDEN.test(value)) return null;
  const text = trimSpaces(value);
  if (text.length < 1 || text.length > KNOWN_LABEL_MAX) return null;
  if (LABEL_FORBIDDEN.test(text) || !LABEL_ALLOWED.test(text)) return null;
  if (redactSensitiveDigits(text) !== text) return null;
  return text;
}

/** US numbers only, same check as a callback. Stored as +1 and ten digits. */
function canonicalPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const valid = validatedPhone(value);
  if (!valid) return null;
  const normal = normalizeCallerNumber(valid);
  if (!normal || !validatedPhone(normal)) return null;
  return normal;
}

function asPerson(value: unknown, seenPhones: string[]): KnownPerson | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "name" && key !== "relation" && key !== "phones") return null;
  }
  const name = knownPersonLabel(record.name);
  const relation = knownPersonLabel(record.relation);
  if (!name || !relation) return null;
  const phones: string[] = [];
  if ("phones" in record) {
    if (!Array.isArray(record.phones) || record.phones.length > MAX_PHONES) return null;
    for (const entry of record.phones) {
      const phone = canonicalPhone(entry);
      if (!phone) return null;
      if (seenPhones.some((prev) => samePhone(prev, phone))) return null;
      seenPhones.push(phone);
      phones.push(phone);
    }
  }
  return { name, relation, phones };
}

function asStored(value: unknown): KnownPeople | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "people") return null;
  }
  if (!Array.isArray(record.people) || record.people.length > MAX_PEOPLE) return null;
  const seenPhones: string[] = [];
  const people: KnownPerson[] = [];
  for (const entry of record.people) {
    const person = asPerson(entry, seenPhones);
    if (!person) return null;
    people.push(person);
  }
  return { people };
}

function writeKnownFile(filePath: string, value: KnownPeople): void {
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

/** Accepts an admin JSON body. A name or relation that fails the label rule rejects the body. Phones are canonical or the body is rejected. */
export function parseKnownPeopleBody(raw: string): { ok: true; value: KnownPeople } | { ok: false } {
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

export function readKnownPeople(dataDir: string): KnownPeopleRead {
  const filePath = knownPeoplePath(dataDir);
  if (!fs.existsSync(filePath)) return { ok: false, reason: "absent" };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > KNOWN_PEOPLE_MAX_FILE_BYTES) return { ok: false, reason: "invalid" };
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const value = asStored(parsed);
    if (!value) return { ok: false, reason: "invalid" };
    if (JSON.stringify(parsed) !== JSON.stringify(value)) {
      try {
        writeKnownFile(filePath, value);
      } catch {
        logError("failed to rewrite known people");
      }
    }
    return { ok: true, value };
  } catch {
    logError("known people file was unreadable");
    return { ok: false, reason: "invalid" };
  }
}

export function writeKnownPeople(dataDir: string, value: KnownPeople): KnownPeople {
  const stored = asStored(value);
  if (!stored) throw new Error("invalid known people");
  writeKnownFile(knownPeoplePath(dataDir), stored);
  return stored;
}

export function deleteKnownPeople(dataDir: string): void {
  try {
    fs.unlinkSync(knownPeoplePath(dataDir));
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "ENOENT") return;
    throw err;
  }
}

/**
 * Caller-ID match only. A spoken name is not a match.
 * The returned entry is for the greeting. Callers must not put the whole list into the prompt.
 */
export function matchKnownPerson(dataDir: string, callerNumber: string | null): KnownPerson | null {
  if (!callerNumber) return null;
  const read = readKnownPeople(dataDir);
  if (!read.ok) return null;
  for (const person of read.value.people) {
    if (person.phones.some((phone) => samePhone(phone, callerNumber))) return person;
  }
  return null;
}
