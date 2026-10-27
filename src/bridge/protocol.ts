import { FALLBACK_VOICE } from "../config.js";
import { FALLBACK_GREETING } from "../greeting.js";

/** Fallback greeting. A live call uses the line picked in greeting.ts. Logs keep the Owner spelling. */
export const GREETING = FALLBACK_GREETING;

export const XAI_REALTIME_URL = "wss://api.x.ai/v1/realtime?model=grok-voice-latest";

export { FALLBACK_VOICE };

export function spokenGreeting(pronunciation: boolean, greeting: string = GREETING): string {
  if (!pronunciation) return greeting;
  return greeting.replaceAll("Owner's", "Owner's").replaceAll("Owner", "Owner");
}

/** Logs store "Owner" even when audio used the spoken substitute. */
export function canonicalizeOwner(text: string): string {
  return text.replaceAll("Owner's", "Owner's").replaceAll("Owner", "Owner");
}

export const RECORD_MESSAGE_TOOL = {
  type: "function",
  name: "record_message",
  description:
    "Save or update the caller's message for Owner. Call this as soon as you know a name or a reason, call it again when you learn more or when the caller asks a question, and always call it before you say goodbye. Omit callback_number to use the number the caller is calling from.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The name the caller gives. Omit it if you do not know it yet." },
      callback_number: {
        type: "string",
        description: "The phone number the caller wants to be reached at. Omit it to use the number they are calling from.",
      },
      reason: { type: "string", description: "Why the caller is calling. Omit it if you do not know it yet." },
      questions: {
        type: "array",
        description:
          "Each question the caller asked. answered is true only for generic availability right now, how to reach him by leaving a message, or what this line is. A ministry, a website, family, a schedule, whereabouts, work, pay, and money stay false.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The caller's question, in their words." },
            answered: {
              type: "boolean",
              description:
                "True only for generic availability, how to reach him, or what this line is. False for a ministry, a website, family, a schedule, whereabouts, work, pay, or money.",
            },
            topic: {
              type: "string",
              description: "availability, reach, or line. Omit it when answered is false.",
            },
          },
          required: ["question", "answered"],
          additionalProperties: false,
        },
      },
      urgent: {
        type: "boolean",
        description:
          "True only when a family member or friend clearly needs Owner soon, or the call is clearly important. Never true for money, a sale, or a possible scam. A possible scam overrides urgent.",
      },
      urgent_reason: {
        type: "string",
        description: "Short reason this call is urgent. Omit it when urgent is not true.",
      },
    },
    required: [],
    additionalProperties: false,
  },
} as const;

export interface SessionUpdate {
  type: "session.update";
  session: Record<string, unknown>;
}

export function buildSessionUpdate(opts: {
  voice: string;
  instructions: string;
  pronunciation: boolean;
}): SessionUpdate {
  const session: Record<string, unknown> = {
    voice: opts.voice,
    instructions: opts.instructions,
    // A message-taking call does not need the default "high" reasoning pauses.
    reasoning: { effort: "none" },
    // silence_duration_ms and threshold are not set. This tree only documents
    // turn_detection.type for the xAI session, so those extra keys would be a guess.
    turn_detection: { type: "server_vad" },
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        // Caller lines are not emitted unless this model is selected.
        transcription: { model: "grok-transcribe", keyterms: ["Owner"] },
      },
      output: { format: { type: "audio/pcmu" } },
    },
    tools: [RECORD_MESSAGE_TOOL],
  };
  if (opts.pronunciation) {
    // Longer key first so a sequential replacer handles the possessive before the bare name.
    session.replace = {
      "Owner's": "Owner's",
      Owner: "Owner",
    };
  }
  return { type: "session.update", session };
}

/** Scripted line. Do not follow this item with response.create. */
export function buildForceMessage(text: string): {
  type: "conversation.item.create";
  item: {
    type: "force_message";
    role: "assistant";
    interruptible: false;
    content: Array<{ type: "output_text"; text: string }>;
  };
} {
  return {
    type: "conversation.item.create",
    item: {
      type: "force_message",
      role: "assistant",
      interruptible: false,
      content: [{ type: "output_text", text }],
    },
  };
}

/** Scripted greeting. Do not follow this item with response.create. */
export function buildGreetingItem(
  pronunciation: boolean,
  greeting: string = GREETING,
): {
  type: "conversation.item.create";
  item: {
    type: "force_message";
    role: "assistant";
    interruptible: false;
    content: Array<{ type: "output_text"; text: string }>;
  };
} {
  return {
    type: "conversation.item.create",
    item: {
      type: "force_message",
      role: "assistant",
      interruptible: false,
      content: [{ type: "output_text", text: spokenGreeting(pronunciation, greeting) }],
    },
  };
}

export function buildFunctionOutput(callId: string, output: unknown): {
  type: "conversation.item.create";
  item: { type: "function_call_output"; call_id: string; output: string };
} {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  };
}

export function buildResponseCreate(): { type: "response.create" } {
  return { type: "response.create" };
}
