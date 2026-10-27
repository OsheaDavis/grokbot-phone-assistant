import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { knownPersonLabel } from "./known-people.js";
import { logError } from "./logger.js";

/** Spoken when the catalog cannot be read. Keeps the recording notice. */
export const FALLBACK_GREETING =
  "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

const EASTERN_ZONE = "America/New_York";
const GREETING_MEMORY_LIMIT = 1024;

export const SEASONAL_IDS = [
  "new_year",
  "valentines",
  "st_patricks",
  "easter",
  "mothers_day",
  "fathers_day",
  "memorial_day",
  "fourth_of_july",
  "labor_day",
  "fall",
  "halloween",
  "veterans_day",
  "thanksgiving",
  "christmas",
  "christmas_special",
] as const;

export type SeasonalId = (typeof SEASONAL_IDS)[number];
export type Occasion = SeasonalId | "everyday";

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface GreetingCatalog {
  everyday: readonly string[];
  relatives: readonly string[];
  gentle: string;
  seasonal: Record<SeasonalId, string>;
}

export interface GreetingMemory {
  recall(caller: string): string | undefined;
  remember(caller: string, greeting: string): void;
}

export interface PickGreetingInput {
  now: Date;
  callerNumber?: string | null;
  lifeActive?: boolean;
  random?: () => number;
  memory?: GreetingMemory;
  catalog?: GreetingCatalog;
  catalogPath?: string;
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  catalog: GreetingCatalog;
}

let cache: CacheEntry | null = null;

export function defaultGreetingsPath(): string {
  return path.resolve(process.cwd(), "config/greetings.json");
}

/**
 * Civil date in America/New_York via Intl. The host timezone is not used.
 */
export function easternCivilDate(now: Date): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    numberingSystem: "latn",
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "";
    return Number(value);
  };
  const date = { year: pick("year"), month: pick("month"), day: pick("day") };
  if (!Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) {
    throw new Error("eastern date unavailable");
  }
  return date;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Anonymous Gregorian computus. Month is 3 (March) or 4 (April). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = mod(year, 19);
  const b = Math.floor(year / 100);
  const c = mod(year, 100);
  const d = Math.floor(b / 4);
  const e = mod(b, 4);
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = mod(19 * a + b - d - g + 15, 30);
  const i = Math.floor(c / 4);
  const k = mod(c, 4);
  const l = mod(32 + 2 * e + 2 * i - h - k, 7);
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function dateNumber(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

function shiftDate(year: number, month: number, day: number, delta: number): CivilDate {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastWeekdayIndex = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return lastDate - ((lastWeekdayIndex - weekday + 7) % 7);
}

function inEaster(year: number, month: number, day: number): boolean {
  const easter = easterSunday(year);
  const start = shiftDate(year, easter.month, easter.day, -2);
  const end = shiftDate(year, easter.month, easter.day, 1);
  const current = dateNumber(year, month, day);
  return current >= dateNumber(start.year, start.month, start.day) && current <= dateNumber(end.year, end.month, end.day);
}

function isThanksgiving(year: number, month: number, day: number): boolean {
  if (month !== 11) return false;
  const thursday = nthWeekday(year, 11, 4, 4);
  return day === thursday || day === thursday + 1;
}

/**
 * Holiday, then fall, otherwise everyday. Life context is applied by pickGreeting.
 * Christmas Eve and Christmas Day are the special line; the rest of Dec 1–26 is Christmas.
 */
export function occasionFor(now: Date): Occasion {
  const { year, month, day } = easternCivilDate(now);
  const monthDay = month * 100 + day;
  if (monthDay === 1231 || monthDay === 101 || monthDay === 102) return "new_year";
  if (monthDay === 214) return "valentines";
  if (monthDay === 317) return "st_patricks";
  if (inEaster(year, month, day)) return "easter";
  if (month === 5 && day === nthWeekday(year, 5, 0, 2)) return "mothers_day";
  if (month === 6 && day === nthWeekday(year, 6, 0, 3)) return "fathers_day";
  if (month === 5 && day === lastWeekday(year, 5, 1)) return "memorial_day";
  if (month === 7 && day >= 3 && day <= 5) return "fourth_of_july";
  if (month === 9 && day === nthWeekday(year, 9, 1, 1)) return "labor_day";
  if (monthDay === 1031) return "halloween";
  if (monthDay === 1111) return "veterans_day";
  if (isThanksgiving(year, month, day)) return "thanksgiving";
  if (month === 12 && (day === 24 || day === 25)) return "christmas_special";
  if (month === 12 && day >= 1 && day <= 26) return "christmas";
  if ((month === 9 && day >= 22) || (month === 10 && day <= 30)) return "fall";
  return "everyday";
}

function hasRecordingNotice(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.includes("owner's ai bot") && lower.includes("this call may be recorded");
}

/** Catalog lines stay name-free. A configured known person is greeted in code, not from these strings. */
const PLACEHOLDER_NAME = /\b(?:uncle jack|grandma|cousin)\b/i;

function assertSpokenLine(line: string | null, requireNotice: boolean): string {
  if (!line || (requireNotice && !hasRecordingNotice(line)) || PLACEHOLDER_NAME.test(line)) {
    throw new Error("greeting catalog is invalid");
  }
  return line;
}

function asLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateCatalog(value: unknown): GreetingCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("greeting catalog is invalid");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "everyday" && key !== "relatives" && key !== "gentle" && key !== "seasonal") {
      throw new Error("greeting catalog is invalid");
    }
  }
  if (!Array.isArray(record.everyday) || record.everyday.length !== 5) {
    throw new Error("greeting catalog is invalid");
  }
  const everyday = record.everyday.map((line) => {
    try {
      return assertSpokenLine(asLine(line), true);
    } catch {
      return null;
    }
  });
  if (everyday.some((line) => line === null)) throw new Error("greeting catalog is invalid");
  if (!Array.isArray(record.relatives) || record.relatives.length !== 3) {
    throw new Error("greeting catalog is invalid");
  }
  const relatives = record.relatives.map((line) => {
    try {
      return assertSpokenLine(asLine(line), true);
    } catch {
      return null;
    }
  });
  if (relatives.some((line) => line === null)) throw new Error("greeting catalog is invalid");
  let gentle: string;
  try {
    gentle = assertSpokenLine(asLine(record.gentle), true);
  } catch {
    throw new Error("greeting catalog is invalid");
  }
  if (!record.seasonal || typeof record.seasonal !== "object" || Array.isArray(record.seasonal)) {
    throw new Error("greeting catalog is invalid");
  }
  const seasonalRecord = record.seasonal as Record<string, unknown>;
  const seasonalKeys = Object.keys(seasonalRecord);
  if (seasonalKeys.length !== SEASONAL_IDS.length) throw new Error("greeting catalog is invalid");
  const seasonal = {} as Record<SeasonalId, string>;
  for (const id of SEASONAL_IDS) {
    let line: string;
    try {
      line = assertSpokenLine(asLine(seasonalRecord[id]), true);
    } catch {
      throw new Error("greeting catalog is invalid");
    }
    seasonal[id] = line;
  }
  return {
    everyday: everyday as string[],
    relatives: relatives as string[],
    gentle,
    seasonal,
  };
}

export function loadGreetingCatalog(filePath = defaultGreetingsPath()): GreetingCatalog {
  const stat = fs.statSync(filePath);
  if (cache && cache.path === filePath && cache.mtimeMs === stat.mtimeMs) return cache.catalog;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("greeting catalog is invalid");
  }
  const catalog = validateCatalog(parsed);
  cache = { path: filePath, mtimeMs: stat.mtimeMs, catalog };
  return catalog;
}

export function greetingLines(catalog: GreetingCatalog): string[] {
  return [...catalog.everyday, catalog.gentle, ...SEASONAL_IDS.map((id) => catalog.seasonal[id])];
}

/** In-memory last greeting per caller. Oldest callers are dropped past the limit. */
export function createGreetingMemory(limit = GREETING_MEMORY_LIMIT): GreetingMemory {
  const cap = Math.max(1, Math.floor(limit));
  const map = new Map<string, string>();
  const touch = (caller: string, greeting: string): void => {
    if (map.has(caller)) map.delete(caller);
    map.set(caller, greeting);
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    recall(caller: string): string | undefined {
      const greeting = map.get(caller);
      if (greeting === undefined) return undefined;
      touch(caller, greeting);
      return greeting;
    },
    remember(caller: string, greeting: string): void {
      touch(caller, greeting);
    },
  };
}

const sharedMemory = createGreetingMemory();

export function processGreetingMemory(): GreetingMemory {
  return sharedMemory;
}

function defaultRandom(): number {
  return crypto.randomInt(0, 1_000_000) / 1_000_000;
}

function pickIndex(random: () => number, length: number): number {
  const sample = random();
  if (!Number.isFinite(sample)) return 0;
  const scaled = Math.floor(sample * length);
  if (scaled <= 0) return 0;
  if (scaled >= length) return length - 1;
  return scaled;
}

function rememberLine(caller: string | null, line: string, memory: GreetingMemory): string {
  if (caller) memory.remember(caller, line);
  return line;
}

function chooseEveryday(
  lines: readonly string[],
  caller: string | null,
  random: () => number,
  memory: GreetingMemory,
): string {
  const last = caller ? memory.recall(caller) : undefined;
  const pool = last ? lines.filter((line) => line !== last) : [...lines];
  const choices = pool.length > 0 ? pool : [...lines];
  const choice = choices[pickIndex(random, choices.length)] ?? FALLBACK_GREETING;
  return rememberLine(caller, choice, memory);
}

export function pickGreeting(input: PickGreetingInput): string {
  if (Number.isNaN(input.now.getTime())) return FALLBACK_GREETING;
  let catalog = input.catalog;
  if (!catalog) {
    try {
      catalog = loadGreetingCatalog(input.catalogPath ?? defaultGreetingsPath());
    } catch {
      logError("greeting catalog could not be loaded");
      return FALLBACK_GREETING;
    }
  }
  const memory = input.memory ?? processGreetingMemory();
  const caller = input.callerNumber && input.callerNumber.length > 0 ? input.callerNumber : null;
  if (input.lifeActive) return rememberLine(caller, catalog.gentle, memory);
  let occasion: Occasion;
  try {
    occasion = occasionFor(input.now);
  } catch {
    logError("eastern date could not be resolved");
    return FALLBACK_GREETING;
  }
  if (occasion === "everyday") {
    return chooseEveryday(catalog.everyday, caller, input.random ?? defaultRandom, memory);
  }
  return rememberLine(caller, catalog.seasonal[occasion], memory);
}

/**
 * Prepend a configured known person's stored name. The catalog line already carries the recording notice.
 * The relation is not spoken. A name that fails the label check leaves the name-free line unchanged.
 */
export function greetKnownCaller(
  line: string,
  person: { name: string; relation: string } | null,
  calm = false,
): string {
  if (!person) return line;
  const name = knownPersonLabel(person.name);
  if (!name) return line;
  const lead = calm ? `${name}, thank you for calling.` : `${name}! Good to hear from you.`;
  return `${lead} ${line}`;
}
