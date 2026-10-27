import path from "node:path";

export const DEFAULT_VOICE = "your-voice-id";
export const FALLBACK_VOICE = "leo";

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  production: boolean;
  dataDir: string;
  xaiApiKey: string | undefined;
  xaiVoice: string;
  pronunciationReplace: boolean;
  twilioAuthToken: string | undefined;
  twilioAccountSid: string | undefined;
  publicBaseUrl: string | undefined;
  summaryWebhookUrl: string | undefined;
  summaryWebhookSecret: string | undefined;
  /** Raw SUMMARY_WEBHOOK_AUTH. Delivery adds a Bearer prefix when the value has no scheme. */
  summaryWebhookAuth: string | undefined;
  messagesBearerToken: string | undefined;
  callersConfigPath: string;
  greetingsConfigPath: string;
  retentionDays: number;
  rateLimitWindowMs: number;
  rateLimitTwilioMax: number;
  rateLimitMessagesMax: number;
  summaryTimeoutMs: number;
  summaryMaxAttempts: number;
  summaryRetryBaseMs: number;
  /** Wait after a terminal status callback before checking for a saved call log. */
  statusGraceMs: number;
  maxCallMs: number;
  spamRepeatMax: number;
  spamRepeatWindowMs: number;
  allowInsecureDevWebhook: boolean;
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

/** Cc covers C0 and C1 controls, including CR, LF, NUL, and DEL. */
const CONTROL_CHAR = /[\p{Cc}]/u;

/**
 * Optional Authorization value. A control character is rejected here so it cannot
 * be written into a header later. The error does not include the value.
 */
function readSummaryWebhookAuth(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SUMMARY_WEBHOOK_AUTH;
  if (value === undefined || value.length === 0) return undefined;
  if (CONTROL_CHAR.test(value)) {
    throw new Error("SUMMARY_WEBHOOK_AUTH contains a control character");
  }
  const next = value.trim();
  return next.length > 0 ? next : undefined;
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function voiceEnv(value: string | undefined): string {
  if (!value) return DEFAULT_VOICE;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(value)) return value;
  return DEFAULT_VOICE;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = trimmed(env, "NODE_ENV") ?? "development";
  const publicBase = trimmed(env, "PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  return {
    port: intEnv(trimmed(env, "PORT"), 8080, 1, 65535),
    host: trimmed(env, "HOST") ?? "0.0.0.0",
    nodeEnv,
    production: nodeEnv === "production",
    dataDir: trimmed(env, "DATA_DIR") ?? path.resolve(process.cwd(), "data"),
    xaiApiKey: trimmed(env, "XAI_API_KEY"),
    xaiVoice: voiceEnv(trimmed(env, "XAI_VOICE")),
    pronunciationReplace: boolEnv(trimmed(env, "XAI_PRONUNCIATION_REPLACE"), true),
    twilioAuthToken: trimmed(env, "TWILIO_AUTH_TOKEN"),
    twilioAccountSid: trimmed(env, "TWILIO_ACCOUNT_SID"),
    publicBaseUrl: publicBase,
    summaryWebhookUrl: trimmed(env, "SUMMARY_WEBHOOK_URL"),
    summaryWebhookSecret: trimmed(env, "SUMMARY_WEBHOOK_SECRET"),
    summaryWebhookAuth: readSummaryWebhookAuth(env),
    messagesBearerToken: trimmed(env, "MESSAGES_BEARER_TOKEN"),
    callersConfigPath: trimmed(env, "CALLERS_CONFIG") ?? path.resolve(process.cwd(), "config/callers.json"),
    greetingsConfigPath: trimmed(env, "GREETINGS_CONFIG") ?? path.resolve(process.cwd(), "config/greetings.json"),
    retentionDays: intEnv(trimmed(env, "RETENTION_DAYS"), 30, 1, 3650),
    rateLimitWindowMs: intEnv(trimmed(env, "RATE_LIMIT_WINDOW_MS"), 60_000, 1000, 3_600_000),
    rateLimitTwilioMax: intEnv(trimmed(env, "RATE_LIMIT_TWILIO_MAX"), 60, 1, 10_000),
    rateLimitMessagesMax: intEnv(trimmed(env, "RATE_LIMIT_MESSAGES_MAX"), 30, 1, 10_000),
    summaryTimeoutMs: intEnv(trimmed(env, "SUMMARY_TIMEOUT_MS"), 5_000, 100, 30_000),
    summaryMaxAttempts: intEnv(trimmed(env, "SUMMARY_MAX_ATTEMPTS"), 3, 1, 5),
    summaryRetryBaseMs: intEnv(trimmed(env, "SUMMARY_RETRY_BASE_MS"), 200, 0, 10_000),
    statusGraceMs: intEnv(trimmed(env, "STATUS_GRACE_MS"), 20_000, 0, 120_000),
    maxCallMs: intEnv(trimmed(env, "MAX_CALL_MS"), 900_000, 10_000, 3_600_000),
    spamRepeatMax: intEnv(trimmed(env, "SPAM_REPEAT_MAX"), 5, 1, 1000),
    spamRepeatWindowMs: intEnv(trimmed(env, "SPAM_REPEAT_WINDOW_MS"), 600_000, 1000, 86_400_000),
    allowInsecureDevWebhook: boolEnv(trimmed(env, "ALLOW_INSECURE_DEV_WEBHOOK"), false),
  };
}
