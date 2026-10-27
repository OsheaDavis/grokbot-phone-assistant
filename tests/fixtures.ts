import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../src/config.js";
import { CallStore } from "../src/store/calls.js";
import type { CallLogEntry } from "../src/types.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    nodeEnv: "test",
    production: false,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "phone-data-")),
    xaiApiKey: "test-xai-key",
    xaiVoice: "your-voice-id",
    pronunciationReplace: true,
    twilioAuthToken: "test-auth-token",
    twilioAccountSid: undefined,
    publicBaseUrl: "https://example.com",
    summaryWebhookUrl: undefined,
    summaryWebhookSecret: undefined,
    summaryWebhookAuth: undefined,
    messagesBearerToken: "test-messages-bearer",
    callersConfigPath: path.resolve("config/callers.json"),
    greetingsConfigPath: path.resolve("config/greetings.json"),
    retentionDays: 30,
    rateLimitWindowMs: 60_000,
    rateLimitTwilioMax: 60,
    rateLimitMessagesMax: 30,
    summaryTimeoutMs: 1000,
    summaryMaxAttempts: 3,
    summaryRetryBaseMs: 0,
    statusGraceMs: 0,
    maxCallMs: 900_000,
    spamRepeatMax: 5,
    spamRepeatWindowMs: 600_000,
    allowInsecureDevWebhook: false,
    ...overrides,
  };
}

export function tempStore(retentionDays = 30): CallStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-log-"));
  return new CallStore(path.join(dir, "calls.json"), retentionDays);
}

export function sampleEntry(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    id: "call-1",
    call_sid: "CA123",
    disposition: "connected",
    caller_number: "+15551212000",
    message: { name: "Jane", callback_number: "+15551212000", reason: "Hello" },
    transcript_summary: "Assistant: Hi.",
    questions: [],
    start_time: "2026-10-10T00:00:00.000Z",
    end_time: "2026-10-10T00:05:00.000Z",
    flags: [],
    ...overrides,
  };
}
