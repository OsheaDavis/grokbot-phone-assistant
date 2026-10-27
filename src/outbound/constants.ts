/** Twilio number this assistant already answers on. Dialing never takes a from-number argument. */
export const OUTBOUND_FROM_NUMBER = "+12025550123";

/** Absent, blank, or anything other than a known on-value means outbound is off. */
export const OUTBOUND_ENABLED_ENV = "OUTBOUND_ENABLED";

/** Separate from MESSAGES_BEARER_TOKEN. Names only are committed; the value stays in the environment. */
export const OUTBOUND_BEARER_ENV = "OUTBOUND_BEARER_TOKEN";

/** A dial approval cannot outlive this. Longer requests are refused, not clamped. */
export const MAX_APPROVAL_MS = 30 * 60 * 1000;

export const DAILY_CALL_CAP = 5;
export const DAILY_MINUTE_CAP = 30;

/** One outbound call cannot run longer than this. Passed to Twilio as timeLimit seconds. */
export const MAX_CALL_SECONDS = 10 * 60;

/** A dial needs at least this much of the daily minute budget left. */
export const MIN_CALL_SECONDS = 60;

/** Inclusive 8:00 AM, exclusive 9:00 PM, in America/New_York. */
export const WINDOW_START_MINUTES = 8 * 60;
export const WINDOW_END_MINUTES = 21 * 60;

export const LOCAL_ZONE = "America/New_York";
