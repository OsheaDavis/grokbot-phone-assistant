import test from "node:test";
import assert from "node:assert/strict";

import { isApprovedSentence } from "../src/allowlist.js";
import { createState, onXaiEvent } from "../src/bridge/machine.js";
import { spokenGreeting } from "../src/bridge/protocol.js";
import { FALLBACK_GREETING, greetKnownCaller, greetingLines, loadGreetingCatalog } from "../src/greeting.js";
import { answerLeaks, screenAssistant } from "../src/guardrail.js";
import { normalizeSpeech } from "../src/normalize.js";
import { DONOR_X_MONEY, PERSONAL_DETAIL_REFUSAL } from "../src/prompt.js";

const NOW = new Date("2026-10-15T15:00:00.000Z");
const GREET = "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

function machine(knownName: string | null = null) {
  return createState({
    callSid: "CASTEP2",
    callerNumber: "+15551212000",
    startedAtMs: NOW.getTime(),
    voice: "your-voice-id",
    pronunciation: false,
    instructions: "Take a message.",
    greeting: GREET,
    knownName,
    flags: [],
  });
}

function mediaPayloads(step: { outbound: Array<{ to: string; payload: unknown }> }): string[] {
  const payloads: string[] = [];
  for (const item of step.outbound) {
    if (item.to !== "twilio") continue;
    const payload = item.payload as { event?: string; media?: { payload?: string } };
    if (payload.event === "media" && payload.media?.payload) payloads.push(payload.media.payload);
  }
  return payloads;
}

function hasClear(step: { outbound: Array<{ to: string; payload: unknown }> }): boolean {
  return step.outbound.some((item) => {
    const payload = item.payload as { event?: string };
    return item.to === "twilio" && payload.event === "clear";
  });
}

function assertRefused(line: string, knownName: string | null = null): void {
  assert.equal(answerLeaks(line, knownName), true, line);
  const screened = screenAssistant(line, { knownName });
  assert.equal(screened.blocked, true, line);
  assert.equal(screened.text, PERSONAL_DETAIL_REFUSAL, line);
}

function assertSpoken(line: string, knownName: string | null = null, donorAllowed = false): void {
  assert.equal(answerLeaks(line, knownName, donorAllowed), false, line);
  const screened = screenAssistant(line, { knownName, donorAllowed });
  assert.equal(screened.blocked, false, line);
  assert.equal(screened.text, line, line);
}

function release(call: ReturnType<typeof machine>, id: string, text: string): void {
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: id,
    delta: "AUD=",
  });
  assert.deepEqual(mediaPayloads(held), [], text);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: id,
    transcript: text,
  });
  assert.equal(hasClear(done), false, text);
  assert.deepEqual(mediaPayloads(done), ["AUD="], text);
}

const REFUSED = [
  "So the reason is his wife is pregnant.",
  "I have your reason as his mom is sick.",
  "I have your name as his wife.",
  "I have your reason as his salary is high.",
  "I have your reason as he has cancer.",
  "Hello daughter Emma.",
  "Wife Sarah Jones.",
  "Send twenty dollars.",
  "Send cash.",
  "That's wonderful.",
  "He loves pizza.",
  "Sure, send twenty dollars to me.",
  "twenty bucks",
  "a dollar",
];

for (const line of REFUSED) {
  test(`step2: ${line}`, () => {
    assertRefused(line, null);
  });
}

test("step2: What's your name?", () => {
  assertSpoken("What's your name?");
});

test("step2: May I have your callback number?", () => {
  assertSpoken("May I have your callback number?");
});

test("step2: So the reason is he wants to volunteer.", () => {
  assertRefused("So the reason is he wants to volunteer.");
});

test("step2: Hi Mom.", () => {
  assertRefused("Hi Mom.", null);
  assertRefused("Hi Mom.", "Dad");
  assertRefused("Hi Mom.", "Mother");
  assertSpoken("Hi Mom.", "Mom");
});

test("step2: Hello daughter. when the stored name is daughter", () => {
  assertRefused("Hello daughter.", null);
  assertSpoken("Hello daughter.", "daughter");
});

test("step2: I am Owner's AI Bot.", () => {
  const line = "I am Owner's AI Bot.";
  assert.equal(normalizeSpeech(line).text, "i am owners ai bot");
  assert.equal(isApprovedSentence("i am owners ai bot"), true);
  assertSpoken(line);
});

test("step2: I can take a message. plus the donor line", () => {
  const line = `I can take a message. ${DONOR_X_MONEY}`;
  assertSpoken(line, null, true);
  const spoken = `I can take a message. ${spokenGreeting(true, DONOR_X_MONEY)}`;
  assertSpoken(spoken, null, true);
  const leaked = `${DONOR_X_MONEY} He makes six figures.`;
  assertRefused(leaked);
});

test("step2: Mom, thank you for calling.", () => {
  const line = `Mom, thank you for calling. ${FALLBACK_GREETING}`;
  assert.equal(greetKnownCaller(FALLBACK_GREETING, { name: "Mom", relation: "mom" }, true), line);
  assertSpoken(line, "Mom");
  assertRefused(line, null);
  assertRefused(line, "Dad");
});

test("step2: Mom! Good to hear from you.", () => {
  const line = "Mom! Good to hear from you.";
  assertSpoken(line, "Mom");
  assertRefused(line, null);
  assertRefused(line, "Dad");
  const full = greetKnownCaller(FALLBACK_GREETING, { name: "Mom", relation: "mom" }, false);
  assertSpoken(full, "Mom");
  assertRefused(full, null);
  assertRefused(full, "Emma");
});

test("step2: a message-taking exchange releases audio", () => {
  const call = machine();
  call.streamSid = "MZMSG";
  release(call, "resp_name", "What's your name?");
  release(call, "resp_callback", "May I have your callback number?");
  release(call, "resp_confirm", "Is the number you are calling from the best callback?");
  release(call, "resp_reason", "What is the reason for your call?");
  assert.equal(call.flags.includes("guardrail"), false);
});

test("step2: a catalog greeting releases audio", () => {
  const line = greetingLines(loadGreetingCatalog())[0] ?? "";
  assert.match(line, /Owner's AI Bot/);
  assert.match(line, /this call may be recorded/);
  const call = machine();
  call.greeting = line;
  call.streamSid = "MZCAT";
  onXaiEvent(call, { type: "session.updated" });
  onXaiEvent(call, { type: "response.created", response: { id: "resp_greet" } });
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "GREET=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const heard = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_greet",
    delta: line,
  });
  assert.equal(hasClear(heard), false);
  assert.deepEqual(mediaPayloads(heard), ["GREET="]);
});

test("step2: a relative hello releases audio only for the stored name", () => {
  const named = machine("Mom");
  named.streamSid = "MZHI";
  release(named, "resp_hi", "Hi Mom.");
  assert.equal(named.flags.includes("guardrail"), false);

  const other = machine(null);
  other.streamSid = "MZNO";
  const held = onXaiEvent(other, {
    type: "response.output_audio.delta",
    response_id: "resp_hi",
    delta: "AUD=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(other, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_hi",
    transcript: "Hi Mom.",
  });
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(other.flags.includes("guardrail"), true);
});

test("step2: the donor line plays after the caller asks to give", () => {
  const call = machine();
  call.streamSid = "MZASK";
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "caller_give",
    transcript: "I want to give.",
  });
  release(call, "resp_donor", `I can take a message. ${DONOR_X_MONEY}`);
  const leaked = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_pay",
    delta: "PAY=",
  });
  assert.deepEqual(mediaPayloads(leaked), []);
  const refused = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_pay",
    transcript: `${DONOR_X_MONEY} He makes six figures.`,
  });
  assert.equal(hasClear(refused), true);
  assert.deepEqual(mediaPayloads(refused), []);
});

test("step2: the donor line is refused when the caller did not ask to give", () => {
  const call = machine();
  call.streamSid = "MZDONOR";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_donor",
    delta: "DON=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_donor",
    transcript: DONOR_X_MONEY,
  });
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.flags.includes("guardrail"), true);
  const later = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_donor",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(later), []);
});

test("step2: a 9046-character first transcript.done still clears", () => {
  const unit = "I can take a message. ";
  const pad = unit.repeat(410);
  const leak = "He lives at 12 Oak Street.";
  assert.equal(pad.length, 9020);
  assert.equal(leak.length, 26);
  const transcript = `${pad}${leak}`;
  assert.equal(transcript.length, 9046);
  assert.equal(answerLeaks(transcript), true);

  const call = machine();
  call.streamSid = "MZ9046";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_long",
    delta: "LONG=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_long",
    transcript,
  });
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.transcript.some((row) => row.text.includes("12 Oak")), false);
  assert.equal(call.flags.includes("guardrail"), true);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_long",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), []);
});

test("step2: a streaming buffer past 8000 characters still guards the leak", () => {
  const pad = "I can take a message. ".repeat(410);
  assert.equal(pad.length, 9020);
  const call = machine();
  call.streamSid = "MZBUF";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_buf",
    delta: "BUF=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const safe = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_buf",
    delta: pad,
  });
  assert.equal(hasClear(safe), false);
  assert.deepEqual(mediaPayloads(safe), []);
  const leaked = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_buf",
    delta: "He lives at 12 Oak Street.",
  });
  assert.equal(hasClear(leaked), true);
  assert.deepEqual(mediaPayloads(leaked), []);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_buf",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  assert.equal(call.transcript.some((row) => row.text.includes("12 Oak")), false);
});
