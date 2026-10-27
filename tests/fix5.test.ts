import test from "node:test";
import assert from "node:assert/strict";

import { createState, onTwilioEvent, onXaiEvent } from "../src/bridge/machine.js";
import { matchesApprovedGreeting, screenAssistant, answerLeaks } from "../src/guardrail.js";
import { PERSONAL_DETAIL_REFUSAL, isPersonalQuestion } from "../src/prompt.js";

const NOW = new Date("2026-10-15T15:00:00.000Z");
const GREET = "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

function machine() {
  return createState({
    callSid: "CAFIX5",
    callerNumber: "+15551212000",
    startedAtMs: NOW.getTime(),
    voice: "your-voice-id",
    pronunciation: false,
    instructions: "Take a message.",
    greeting: GREET,
    knownName: null,
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

function refusalText(step: { outbound: Array<{ to: string; payload: unknown }> }): string {
  const spoken = step.outbound.find((item) => item.to === "xai");
  const payload = spoken?.payload as { item?: { type?: string; content?: Array<{ text?: string }> } };
  assert.equal(payload?.item?.type, "force_message");
  return payload?.item?.content?.[0]?.text ?? "";
}

function assertLeak(line: string): void {
  assert.equal(answerLeaks(line), true, line);
  const screened = screenAssistant(line);
  assert.equal(screened.blocked, true, line);
  assert.equal(screened.text, PERSONAL_DETAIL_REFUSAL, line);
}

function assertSafe(line: string): void {
  assert.equal(answerLeaks(line), false, line);
  const screened = screenAssistant(line);
  assert.equal(screened.blocked, false, line);
  assert.equal(screened.text, line, line);
}

test("fix5: Meet-him at-the-park.", () => {
  assertLeak("Meet-him at-the-park.");
});

test("fix5: Meet.him by.the.river.", () => {
  assertLeak("Meet.him by.the.river.");
});

test("fix5: Catch-him at-the-gym.", () => {
  assertLeak("Catch-him at-the-gym.");
});

test("fix5: He'll be at-the-store.", () => {
  assertLeak("He'll be at-the-store.");
});

test("fix5: He is-at the hospital.", () => {
  assertLeak("He is-at the hospital.");
});

test("fix5: He is at the hospital, details are on the website.", () => {
  assertLeak("He is at the hospital, details are on the website.");
});

test("fix5: He will be at the coffee shop. See exampleowner.org.", () => {
  assertLeak("He will be at the coffee shop. See exampleowner.org.");
});

test("fix5: He is nearby. His ministry serves people online.", () => {
  assertLeak("He is nearby. His ministry serves people online.");
});

test("fix5: His ministry serves people nearby and online.", () => {
  const line = "His ministry serves people nearby and online.";
  assertLeak(line);
  assertLeak(`${line} He is at the hospital.`);
});

test("fix5: His ministry is at exampleowner.org.", () => {
  const line = "His ministry is at exampleowner.org.";
  assertLeak(line);
  assertLeak(`${line} He is at the hospital.`);
});

test("fix5: You can find his ministry work at the church website, exampleowner.org.", () => {
  const line = "You can find his ministry work at the church website, exampleowner.org.";
  assertLeak(line);
  assertLeak(`${line} He is at the hospital.`);
});

test("fix5: He speaks at the church on Sundays, details are on the website.", () => {
  const line = "He speaks at the church on Sundays, details are on the website.";
  assertLeak(line);
  assertLeak(`${line} He is at the hospital.`);
});

test("fix5: His ministry work is public on the website.", () => {
  const line = "His ministry work is public on the website.";
  assertLeak(line);
  assertLeak(`${line} He is nearby.`);
});

test("fix5: Good evening. I'm Owner's AI Bot; I take messages for him.", () => {
  const line = "Good evening. I'm Owner's AI Bot; I take messages for him.";
  assertSafe(line);
  assert.equal(isPersonalQuestion(line), false);
});

test("fix5: Good afternoon. I am Owner's AI Bot and I take messages for him.", () => {
  const line = "Good afternoon. I am Owner's AI Bot and I take messages for him.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
});

test("fix5: Happy Saturday! I'm Owner's AI Bot. I take messages for him.", () => {
  const line = "Happy Saturday! I'm Owner's AI Bot. I take messages for him.";
  assertSafe(line);
  assert.equal(isPersonalQuestion(line), false);
});

test("fix5: Feel free to leave a message. I'm Owner's AI Bot.", () => {
  const line = "Feel free to leave a message. I'm Owner's AI Bot.";
  assertSafe(line);
  assert.equal(isPersonalQuestion(line), false);
});

test("fix5: This line is not a direct phone number. I take messages for him.", () => {
  const line = "This line is not a direct phone number. I take messages for him.";
  assertSafe(line);
  assert.equal(isPersonalQuestion(line), false);
});

test("fix5: He is busy this evening until 9.", () => {
  const line = "He is busy this evening until 9.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
  assertSafe("Good evening. I'm Owner's AI Bot; I take messages for him.");
});

test("fix5: He'll be back Saturday afternoon.", () => {
  const line = "He'll be back Saturday afternoon.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
  assertSafe("Happy Saturday! I'm Owner's AI Bot. I take messages for him.");
});

test("fix5: His direct number is 202-555-0199.", () => {
  const line = "His direct number is 202-555-0199.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
});

test("fix5: Call his cell directly.", () => {
  const line = "Call his cell directly.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
});

test("fix5: His email is owner@example.com.", () => {
  const line = "His email is owner@example.com.";
  assertLeak(line);
  assert.equal(isPersonalQuestion(line), true);
  assertSafe("This line is not a direct phone number. I take messages for him.");
});

test("fix5: an empty transcript is not a greeting prefix", () => {
  assert.equal(matchesApprovedGreeting("", GREET), false);
  assert.equal(matchesApprovedGreeting("   ", GREET), false);
  const call = machine();
  onXaiEvent(call, { type: "session.updated" });
  onXaiEvent(call, { type: "response.created", response: { id: "resp_greet" } });
  onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "EARLY=",
  });
  const start = onTwilioEvent(call, {
    event: "start",
    streamSid: "MZSTART",
    start: { streamSid: "MZSTART" },
  });
  assert.deepEqual(mediaPayloads(start), []);
  assert.equal(hasClear(start), false);
  const after = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "LATE=",
  });
  assert.deepEqual(mediaPayloads(after), []);
  assert.equal(call.flags.includes("guardrail"), false);
});

test("fix5: one-word prefix Hi sends no further greeting media", () => {
  const call = machine();
  call.streamSid = "MZHI";
  onXaiEvent(call, { type: "session.updated" });
  onXaiEvent(call, { type: "response.created", response: { id: "resp_greet" } });
  const early = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "EARLY=",
  });
  assert.deepEqual(mediaPayloads(early), []);
  const hi = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_greet",
    delta: "Hi",
  });
  assert.deepEqual(mediaPayloads(hi), []);
  assert.equal(hasClear(hi), false);
  const one = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "ONE=",
  });
  assert.deepEqual(mediaPayloads(one), []);
  assert.equal(hasClear(one), false);
  const more = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_greet",
    delta: ", this is Owner's AI Bot",
  });
  const two = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "TWO=",
  });
  assert.deepEqual(mediaPayloads(more), ["EARLY=", "ONE="]);
  assert.deepEqual(mediaPayloads(two), ["TWO="]);
  assert.equal(hasClear(more), false);
  assert.equal(hasClear(two), false);
  assert.equal(call.flags.includes("guardrail"), false);
});

test("fix5: post-done delta He lives at 12 Oak Street. clears and sends no further media", () => {
  const call = machine();
  call.streamSid = "MZPOST";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_post",
    delta: "AAA=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_post",
    transcript: "I can take a message.",
  });
  assert.deepEqual(mediaPayloads(done), ["AAA="]);
  const late = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_post",
    delta: "He lives at 12 Oak Street.",
  });
  assert.equal(hasClear(late), true);
  assert.deepEqual(mediaPayloads(late), []);
  assert.equal(refusalText(late), PERSONAL_DETAIL_REFUSAL);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_post",
    delta: "BBB=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  const fin = onXaiEvent(call, { type: "response.done", response: { id: "resp_post" } });
  assert.deepEqual(mediaPayloads(fin), []);
  assert.equal(call.transcript.some((line) => line.text.includes("12 Oak")), false);
  assert.equal(call.flags.includes("guardrail"), true);

  const queued = machine();
  onXaiEvent(queued, {
    type: "response.output_audio.delta",
    response_id: "resp_q",
    delta: "AAA=",
  });
  onXaiEvent(queued, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_q",
    transcript: "I can take a message.",
  });
  const tripped = onXaiEvent(queued, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_q",
    delta: "He lives at 12 Oak Street.",
  });
  assert.equal(refusalText(tripped), PERSONAL_DETAIL_REFUSAL);
  const start = onTwilioEvent(queued, {
    event: "start",
    streamSid: "MZQ",
    start: { streamSid: "MZQ" },
  });
  assert.deepEqual(mediaPayloads(start), []);
  const again = onXaiEvent(queued, {
    type: "response.output_audio.delta",
    response_id: "resp_q",
    delta: "CCC=",
  });
  assert.deepEqual(mediaPayloads(again), []);
  const ended = onXaiEvent(queued, { type: "response.done", response: { id: "resp_q" } });
  assert.deepEqual(mediaPayloads(ended), []);
});
