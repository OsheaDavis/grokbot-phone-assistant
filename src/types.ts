export const KNOWN_FLAGS = [
  "allowlisted",
  "blocked",
  "injection_attempt",
  "guardrail",
  "life_context_active",
  "money_related",
  "possible_scam",
  "spam",
  "auto_summary",
  "urgent",
] as const;

export type CallFlag = (typeof KNOWN_FLAGS)[number];

export interface MessageFields {
  name: string | null;
  callback_number: string | null;
  reason: string | null;
}

/** One caller question on the summary. `answered` is false when the bot could not answer. */
export interface CallQuestion {
  question: string;
  answered: boolean;
}

/** status_only: a Twilio status callback for a call with no saved log. */
export type Disposition = "connected" | "blocked" | "spam" | "unavailable" | "status_only";

/** Local JSON log entry. The desk webhook uses CallSummary, not this shape. */
export interface CallLogEntry {
  id: string;
  call_sid: string | null;
  disposition: Disposition;
  caller_number: string | null;
  message: MessageFields;
  transcript_summary: string;
  start_time: string;
  end_time: string;
  flags: CallFlag[];
  /** Absent on calls saved before questions were recorded. */
  questions?: CallQuestion[];
}

/** Body posted to SUMMARY_WEBHOOK_URL and returned by GET /messages. */
export interface CallSummary {
  caller_number: string | null;
  name: string | null;
  callback_number: string | null;
  reason: string | null;
  transcript_summary: string;
  /** Caller questions, redacted. Empty when none were asked. */
  questions: CallQuestion[];
  start_time: string;
  end_time: string;
  flags: CallFlag[];
  /** True only when flags includes urgent. possible_scam clears both. */
  urgent: boolean;
}

export function emptyMessage(): MessageFields {
  return { name: null, callback_number: null, reason: null };
}
