import { redactSensitiveDigits } from "./redact.js";

const secrets: string[] = [];

/** Remember secret values so they can be stripped if they ever reach a log line. */
export function registerSecrets(values: Array<string | undefined>): void {
  for (const value of values) {
    if (value && value.length >= 8 && !secrets.includes(value)) {
      secrets.push(value);
    }
  }
}

/** Shared by log, warning, and error lines. Secrets first, then the digit allowlist. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return redactSensitiveDigits(out);
}

export function logInfo(message: string): void {
  console.log(redact(message));
}

export function logWarn(message: string): void {
  console.warn(redact(message));
}

export function logError(message: string): void {
  console.error(redact(message));
}
