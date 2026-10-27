const ANON_WORDS = new Set([
  "anonymous",
  "restricted",
  "unknown",
  "unavailable",
  "private",
  "withheld",
  "blocked",
  "null",
  "undefined",
]);

/** Keypad spellings Twilio has used for withheld caller ID. */
const ANON_DIGITS = new Set([
  "266696687",
  "7378742833",
  "8656696",
]);

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export function isAnonymousCaller(input: string | null | undefined): boolean {
  if (input == null) return true;
  const trimmed = input.trim();
  if (!trimmed) return true;
  const word = trimmed.toLowerCase().replace(/^\+/, "");
  if (ANON_WORDS.has(word)) return true;
  const digits = digitsOnly(trimmed);
  if (!digits) return true;
  const noCountry = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ANON_DIGITS.has(digits) || ANON_DIGITS.has(noCountry);
}

export function normalizeCallerNumber(input: string | null | undefined): string | null {
  if (!input || isAnonymousCaller(input)) return null;
  const trimmed = input.trim();
  const digits = digitsOnly(trimmed);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

function stripUsCountry(digits: string): string {
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Match E.164 and common US local forms. Short numbers do not match. */
export function samePhone(a: string, b: string): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < 10 || db.length < 10) return false;
  if (da === db) return true;
  return stripUsCountry(da) === stripUsCountry(db);
}

export function maskPhone(phone: string | null): string {
  if (!phone) return "unknown";
  const digits = digitsOnly(phone);
  if (digits.length < 4) return "unknown";
  return `***${digits.slice(-4)}`;
}
