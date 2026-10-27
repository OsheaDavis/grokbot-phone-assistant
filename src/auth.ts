import { safeEqual } from "./safe-equal.js";

export function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return false;
  }
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match || !match[1]) {
    safeEqual(expected, expected);
    return false;
  }
  return safeEqual(match[1], expected);
}
