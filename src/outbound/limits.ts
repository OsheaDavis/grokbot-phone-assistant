import { LOCAL_ZONE, WINDOW_END_MINUTES, WINDOW_START_MINUTES } from "./constants.js";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(nowMs: number): LocalParts | null {
  if (!Number.isFinite(nowMs)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: LOCAL_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      numberingSystem: "latn",
    }).formatToParts(new Date(nowMs));
  } catch {
    return null;
  }
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? "";
    return Number(value);
  };
  let hour = pick("hour");
  if (hour === 24) hour = 0;
  const parsed = {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour,
    minute: pick("minute"),
  };
  if (!Number.isInteger(parsed.year) || !Number.isInteger(parsed.month) || !Number.isInteger(parsed.day)) {
    return null;
  }
  if (!Number.isInteger(parsed.hour) || parsed.hour < 0 || parsed.hour > 23) return null;
  if (!Number.isInteger(parsed.minute) || parsed.minute < 0 || parsed.minute > 59) return null;
  return parsed;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Eastern civil date, or null when the zone cannot be resolved. */
export function localDayKey(nowMs: number): string | null {
  const parts = localParts(nowMs);
  if (!parts) return null;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * True from 8:00 AM inclusive through 9:00 PM exclusive, America/New_York.
 * An unresolved clock is outside the window so a dial cannot proceed.
 */
export function withinCallingWindow(nowMs: number): boolean {
  const parts = localParts(nowMs);
  if (!parts) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return minutes >= WINDOW_START_MINUTES && minutes < WINDOW_END_MINUTES;
}
