import fs from "node:fs";

import { logError } from "./logger.js";
import { samePhone } from "./phone.js";

export interface CallerLists {
  allowlist: string[];
  blocklist: string[];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function loadCallerLists(filePath: string): CallerLists {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("callers config must be an object");
    }
    const record = parsed as Record<string, unknown>;
    return {
      allowlist: asStringArray(record.allowlist),
      blocklist: asStringArray(record.blocklist),
    };
  } catch {
    logError("failed to read callers config; using empty allowlist and blocklist");
    return { allowlist: [], blocklist: [] };
  }
}

export function isListed(phone: string, list: string[]): boolean {
  return list.some((entry) => samePhone(entry, phone));
}
