import { bearerMatches } from "../auth.js";
import { OUTBOUND_BEARER_ENV, OUTBOUND_ENABLED_ENV } from "./constants.js";

const ON = new Set(["1", "true", "yes", "on"]);

/**
 * Outbound is off unless OUTBOUND_ENABLED is explicitly on.
 * A missing variable, a blank value, or an unknown value all stay off.
 */
export function outboundEnabled(env: NodeJS.ProcessEnv): boolean {
  if (!Object.prototype.hasOwnProperty.call(env, OUTBOUND_ENABLED_ENV)) return false;
  const raw = env[OUTBOUND_ENABLED_ENV];
  if (typeof raw !== "string") return false;
  return ON.has(raw.trim().toLowerCase());
}

/** The outbound bearer, or undefined when it is unset or blank. */
export function outboundBearer(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[OUTBOUND_BEARER_ENV];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Constant-time check of an Authorization header against the outbound bearer only. */
export function outboundBearerOk(header: string | undefined, env: NodeJS.ProcessEnv): boolean {
  return bearerMatches(header, outboundBearer(env));
}
