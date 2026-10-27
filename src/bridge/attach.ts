import WebSocket, { type RawData } from "ws";

import type { AppConfig } from "../config.js";
import { greetKnownCaller, pickGreeting, processGreetingMemory } from "../greeting.js";
import { matchKnownPerson } from "../known-people.js";
import { activeLifeContext } from "../life-context.js";
import { logWarn } from "../logger.js";
import { buildInstructions } from "../prompt.js";
import { normalizeFlags } from "../summary/payload.js";
import type { CallLogEntry } from "../types.js";
import { XAI_REALTIME_URL } from "./protocol.js";
import { createState, finalizeCall, onTwilioEvent, onXaiEvent, onXaiOpen, type Step } from "./machine.js";

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export interface XaiSocketOptions {
  headers: { Authorization: string };
  handshakeTimeout: number;
  maxPayload: number;
}

export interface AttachInput {
  twilio: WebSocket;
  config: AppConfig;
  callSid: string;
  callerNumber: string | null;
  flags: readonly string[];
  startedAtMs: number;
  onComplete: (entry: CallLogEntry) => void;
  connectXai?: (url: string, options: XaiSocketOptions) => WebSocket;
  sessionReadyMs?: number;
}

export function attachBridge(input: AttachInput): void {
  if (!input.config.xaiApiKey) {
    logWarn("xAI API key is not configured; closing media stream");
    try {
      input.twilio.close();
    } catch {
      /* socket already closed */
    }
    return;
  }

  const now = new Date(input.startedAtMs);
  const life = activeLifeContext(input.config.dataDir, now);
  const known = matchKnownPerson(input.config.dataDir, input.callerNumber);
  // Display name only. The relation stays in the file and is not passed onward.
  const knownHint = known ? { name: known.name, relation: "" } : null;
  const flags = normalizeFlags(
    life
      ? [...input.flags, "life_context_active"]
      : input.flags.filter((flag) => flag !== "life_context_active"),
  );
  const greeting = greetKnownCaller(
    pickGreeting({
      now,
      callerNumber: input.callerNumber,
      lifeActive: Boolean(life),
      memory: processGreetingMemory(),
      catalogPath: input.config.greetingsConfigPath,
    }),
    knownHint,
    Boolean(life),
  );
  let state = createState({
    callSid: input.callSid,
    callerNumber: input.callerNumber,
    startedAtMs: input.startedAtMs,
    voice: input.config.xaiVoice,
    pronunciation: input.config.pronunciationReplace,
    instructions: buildInstructions(
      input.callerNumber,
      now,
      // Presence selects the gentle tone. The note text is not model context.
      life ? { note: "", allowShare: false } : null,
      knownHint,
      [],
    ),
    flags,
    greeting,
    knownName: known?.name ?? null,
    approvedTopics: [],
  });

  let done = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const connect = input.connectXai ?? ((url: string, options: XaiSocketOptions) => new WebSocket(url, options));
  const xai = connect(XAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${input.config.xaiApiKey}` },
    handshakeTimeout: 10_000,
    maxPayload: 5_000_000,
  });

  const sendXai = (payload: unknown): void => {
    if (xai.readyState === WebSocket.OPEN) xai.send(JSON.stringify(payload));
  };
  const sendTwilio = (payload: unknown): void => {
    if (input.twilio.readyState === WebSocket.OPEN) input.twilio.send(JSON.stringify(payload));
  };

  const apply = (step: Step): void => {
    if (done) return;
    state = step.state;
    if (step.log) logWarn(step.log.message);
    for (const message of step.outbound) {
      if (message.to === "xai") sendXai(message.payload);
      else sendTwilio(message.payload);
    }
    if (step.fatal || state.ended) finish();
  };

  const finish = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (readyTimer) clearTimeout(readyTimer);
    const entry = finalizeCall(state, Date.now());
    try {
      xai.close();
    } catch {
      /* already closed */
    }
    try {
      input.twilio.close();
    } catch {
      /* already closed */
    }
    input.onComplete(entry);
  };

  const timer = setTimeout(finish, input.config.maxCallMs);
  readyTimer = setTimeout(() => {
    if (!done && !state.xaiReady) {
      logWarn("xAI session was not ready; ending call");
      finish();
    }
  }, input.sessionReadyMs ?? 20_000);

  xai.on("open", () => {
    apply(onXaiOpen(state));
  });
  xai.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data)) as unknown;
    } catch {
      return;
    }
    apply(onXaiEvent(state, parsed));
  });
  xai.on("error", (err: Error) => {
    logWarn(`xAI realtime socket error name=${err.name}`);
  });
  xai.on("close", () => {
    finish();
  });

  input.twilio.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data)) as unknown;
    } catch {
      return;
    }
    apply(onTwilioEvent(state, parsed));
  });
  input.twilio.on("error", (err: Error) => {
    logWarn(`twilio media socket error name=${err.name}`);
  });
  input.twilio.on("close", () => {
    finish();
  });
}
