import test from "node:test";
import assert from "node:assert/strict";

import { createState, onTwilioEvent, onXaiEvent } from "../src/bridge/machine.js";
import { spokenGreeting } from "../src/bridge/protocol.js";
import { isApprovedSentence } from "../src/allowlist.js";
import { greetingLines, loadGreetingCatalog } from "../src/greeting.js";
import { answerLeaks, greetingDiverged, greetingPrefixReady, screenAssistant } from "../src/guardrail.js";
import { normalizeSpeech } from "../src/normalize.js";
import {
  AVAILABILITY_ANSWER,
  DONOR_X_MONEY,
  LINE_ANSWER,
  PERSONAL_DETAIL_REFUSAL,
  REACH_ANSWER,
  isPersonalQuestion,
} from "../src/prompt.js";

const NOW = new Date("2026-10-15T15:00:00.000Z");
const GREET = "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function machine() {
  return createState({
    callSid: "CAOPTB",
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

function assertLeak(line: string): void {
  assert.equal(answerLeaks(line), true, line);
  const screened = screenAssistant(line);
  assert.equal(screened.blocked, true, line);
  assert.equal(screened.text, PERSONAL_DETAIL_REFUSAL, line);
}

function assertPass(line: string, donorAllowed = false): void {
  assert.equal(answerLeaks(line, null, donorAllowed), false, line);
  const speech = normalizeSpeech(line);
  for (const sentence of speech.sentences) {
    const key = sentence.join(" ");
    assert.equal(isApprovedSentence(key), true, key);
  }
  const screened = screenAssistant(line, { donorAllowed });
  assert.equal(screened.blocked, false, line);
  assert.equal(screened.text, line, line);
}

test("optionB: no-space periods are sentences and joins are word breaks", () => {
  const nearby = normalizeSpeech("He is nearby.His ministry serves people online.");
  assert.deepEqual(
    nearby.sentences.map((words) => words.join(" ")),
    ["he is nearby", "his ministry serves people online"],
  );
  const hospital = normalizeSpeech("He is at the hospital.See exampleowner.org.");
  assert.deepEqual(
    hospital.sentences.map((words) => words.join(" ")),
    ["he is at the hospital", "see exampleownerorg"],
  );
  assert.deepEqual(normalizeSpeech("He is at-the-hospital.").words, ["he", "is", "at", "the", "hospital"]);
  assert.deepEqual(normalizeSpeech("He is at.the.hospital.").words, ["he", "is", "at", "the", "hospital"]);
  assert.equal(normalizeSpeech("See exampleowner.org today.").text, "see exampleownerorg today");
  assert.equal(normalizeSpeech("See exampleowner org today.").text, "see exampleownerorg today");
});

const ITEM1 = [
  "He is at the hospital website.",
  "He will be at the coffee shop ministry.",
  "He will be at the coffee shop for the website.",
  "He is at the hospital for the ministry.",
  "He is at the hospital with the website.",
];
for (const line of ITEM1) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
  });
}

const ITEM2 = [
  "He is nearby.His ministry serves people online.",
  "He is at the hospital.See exampleowner.org.",
];
for (const line of ITEM2) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
  });
}

const ITEM3 = [
  "He will be at-the-coffee-shop.",
  "He is at-the-hospital.",
  "He is at.the.hospital.",
  "He will be at the coffee-shop.",
];
for (const line of ITEM3) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
  });
}

const ITEM4_LEAK = [
  "He is busy good evening until 9.",
  "He is busy. Good evening until 9.",
  "He'll be back happy Saturday.",
  "He's available good evening.",
  "Call him good evening.",
  "Feel free after 6.",
  "He is busy this evening until 9.",
];
for (const line of ITEM4_LEAK) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
    assert.equal(isPersonalQuestion(line), true, line);
  });
}

test("optionB: Good evening. I'm Owner's AI Bot; I take messages for him.", () => {
  const line = "Good evening. I'm Owner's AI Bot; I take messages for him.";
  assertPass(line);
  assert.equal(isPersonalQuestion(line), false);
});

test("optionB: Hi t and Hi th release no greeting media", () => {
  assert.equal(greetingPrefixReady("Hi t", GREET), false);
  assert.equal(greetingPrefixReady("Hi th", GREET), false);
  assert.equal(greetingPrefixReady("", GREET), false);
  assert.equal(greetingPrefixReady("Hi", GREET), false);
  assert.equal(greetingDiverged("Hi t", GREET), false);
  assert.equal(greetingDiverged("Hi th", GREET), false);
  assert.equal(greetingPrefixReady("Hi, this ", GREET), true);
  assert.equal(greetingDiverged("Hi there ", GREET), true);

  for (const partial of ["Hi t", "Hi th"]) {
    const call = machine();
    call.streamSid = "MZPART";
    onXaiEvent(call, { type: "session.updated" });
    onXaiEvent(call, { type: "response.created", response: { id: "resp_greet" } });
    const early = onXaiEvent(call, {
      type: "response.output_audio.delta",
      response_id: "resp_greet",
      delta: "EARLY=",
    });
    assert.deepEqual(mediaPayloads(early), [], partial);
    const heard = onXaiEvent(call, {
      type: "response.output_audio_transcript.delta",
      response_id: "resp_greet",
      delta: partial,
    });
    assert.deepEqual(mediaPayloads(heard), [], partial);
    assert.equal(hasClear(heard), false, partial);
    const late = onXaiEvent(call, {
      type: "response.output_audio.delta",
      response_id: "resp_greet",
      delta: "LATE=",
    });
    assert.deepEqual(mediaPayloads(late), [], partial);
    assert.equal(hasClear(late), false, partial);
  }

  const call = machine();
  call.streamSid = "MZTHERE";
  onXaiEvent(call, { type: "session.updated" });
  onXaiEvent(call, { type: "response.created", response: { id: "resp_greet" } });
  onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "EARLY=",
  });
  onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_greet",
    delta: "Hi t",
  });
  const rest = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_greet",
    delta: "ere he lives at 12 Oak Street.",
  });
  assert.equal(hasClear(rest), true);
  assert.deepEqual(mediaPayloads(rest), []);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_greet",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  assert.equal(call.transcript.some((row) => row.text.includes("12 Oak")), false);
});

const ITEM6 = [
  "Call his cell directly.",
  "His direct number is 202-555-0199.",
  "Call his-cell.",
  "Call his cell-directly.",
  "His direct-number is the one to use.",
];
for (const line of ITEM6) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
    assert.equal(isPersonalQuestion(line), true, line);
  });
}

test("optionB: a post-done delta after 8000 safe chars still clears", () => {
  const unit = "I can take a message. ";
  const pad = unit.repeat(Math.ceil(8000 / unit.length));
  assert.ok(pad.length >= 8000);
  assert.equal(pad.length % unit.length, 0);
  assert.equal(answerLeaks(pad), false);
  const leaked = `${pad}He lives at 12 Oak Street.`;
  assert.equal(answerLeaks(leaked), true);

  const call = machine();
  call.streamSid = "MZ8K";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_pad",
    delta: "AAA=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_pad",
    transcript: pad,
  });
  assert.deepEqual(mediaPayloads(done), ["AAA="]);
  assert.equal(hasClear(done), false);
  const late = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_pad",
    delta: "He lives at 12 Oak Street.",
  });
  assert.equal(hasClear(late), true);
  assert.deepEqual(mediaPayloads(late), []);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_pad",
    delta: "BBB=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  const fin = onXaiEvent(call, { type: "response.done", response: { id: "resp_pad" } });
  assert.deepEqual(mediaPayloads(fin), []);
  assert.equal(call.transcript.some((row) => row.text.includes("12 Oak")), false);
  assert.equal(call.flags.includes("guardrail"), true);
});

test("optionB: a second transcript.done is guarded", () => {
  const call = machine();
  call.streamSid = "MZ2ND";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_two",
    delta: "AAA=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const first = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_two",
    transcript: "I can take a message.",
  });
  assert.deepEqual(mediaPayloads(first), ["AAA="]);
  assert.equal(hasClear(first), false);
  const second = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_two",
    transcript: "I can take a message. He lives at 12 Oak Street.",
  });
  assert.equal(hasClear(second), true);
  assert.deepEqual(mediaPayloads(second), []);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_two",
    delta: "BBB=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  const queued = onTwilioEvent(call, {
    event: "start",
    streamSid: "MZ2NDB",
    start: { streamSid: "MZ2NDB" },
  });
  assert.deepEqual(mediaPayloads(queued), []);
  assert.equal(call.transcript.some((row) => row.text.includes("12 Oak")), false);
  assert.equal(call.flags.includes("guardrail"), true);
});

const ITEM8 = [
  "His ministry is nearby.",
  "The ministry is nearby.",
  "His ministry serves people nearby and online.",
  "His ministry meets at the church.",
];
for (const line of ITEM8) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
    assert.equal(isPersonalQuestion(line), true, line);
  });
}

const ITEM9 = [
  "He is busy Sunday. See the website.",
  "He speaks at the hospital on Sundays, details are on the website.",
];
for (const line of ITEM9) {
  test(`optionB: ${line}`, () => {
    assertLeak(line);
    assert.equal(isPersonalQuestion(line), true, line);
  });
}

const APPROVED = [
  "Good morning.",
  "Good afternoon.",
  "Good evening.",
  "Good night.",
  "Have a good evening.",
  "Have a great evening.",
  "Feel free to leave a message.",
  "This line is not a direct phone number.",
  "I take messages for him.",
  "I'm Owner's AI Bot",
  "I am Owner's AI Bot",
  "I'm Owner's AI Bot.",
  "I am Owner's AI Bot.",
  "I'm Owner's AI Bot; I take messages for him.",
  DONOR_X_MONEY,
  spokenGreeting(true, DONOR_X_MONEY),
  AVAILABILITY_ANSWER,
  REACH_ANSWER,
  LINE_ANSWER,
  PERSONAL_DETAIL_REFUSAL,
  "I can take a message.",
  "Good evening. I'm Owner's AI Bot; I take messages for him.",
  "This call may be recorded.",
];

test("optionB: each approved public line passes", () => {
  for (const day of WEEKDAYS) {
    assertPass(`Happy ${day}!`);
  }
  for (const line of APPROVED) {
    const donor = line === DONOR_X_MONEY || line === spokenGreeting(true, DONOR_X_MONEY);
    assertPass(line, donor);
    assert.equal(isPersonalQuestion(line, null, true), false, line);
  }
  const catalog = loadGreetingCatalog();
  const greetings = [...greetingLines(catalog), ...catalog.relatives];
  assert.equal(greetings.length, 24);
  for (const line of greetings) {
    assertPass(line);
    assertPass(spokenGreeting(true, line));
    assert.equal(isPersonalQuestion(line), false, line);
    assert.equal(isPersonalQuestion(spokenGreeting(true, line)), false, line);
  }
  assertLeak("I am Owner's AI Bot and I take messages for him.");
});

const NEAR_MISS = [
  "He is at the hospital website.",
  "He is busy good evening until 9.",
  "Feel free after 6.",
  "Good evening until 9.",
  "Happy Saturday he is home.",
  "His ministry is nearby the hospital.",
  "His ministry serves people nearby.",
  "Have a great evening at the office.",
  "I'm Owner's AI Bot and he is at the park.",
  "He isn't free right now until Monday.",
  "You can read about the ministry at the hospital.",
  "His ministry meets at the coffee shop.",
  "He is at the hospital for the ministry.",
  "Call him good evening.",
  "He'll be back happy Saturday.",
  "The ministry is nearby the store.",
  "Feel free to leave a message tomorrow.",
  "He'll be back in May.",
  "His ministry is at exampleowner.org.",
  "You can read about the ministry at exampleowner.org.",
  "His ministry work is public on the website.",
  "He speaks at the church on Sundays, details are on the website.",
  "He isn't free right now, but I can take a message.",
];

test("optionB: near-miss place and schedule lines trip", () => {
  for (const line of NEAR_MISS) {
    assertLeak(line);
  }
});
