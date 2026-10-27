import test from "node:test";
import assert from "node:assert/strict";

import { createState, onXaiEvent } from "../src/bridge/machine.js";
import { spokenGreeting } from "../src/bridge/protocol.js";
import { greetingLines, loadGreetingCatalog } from "../src/greeting.js";
import { answerLeaks, screenAssistant } from "../src/guardrail.js";
import { DONOR_X_MONEY, PERSONAL_DETAIL_REFUSAL } from "../src/prompt.js";

const NOW = new Date("2026-10-15T15:00:00.000Z");
const GREET = "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

function machine(knownName: string | null = null) {
  return createState({
    callSid: "CASTEP5",
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

function callerCompleted(call: ReturnType<typeof machine>, itemId: string, transcript: string): void {
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

function recordUrgent(call: ReturnType<typeof machine>, id: string): void {
  onXaiEvent(call, {
    type: "response.function_call_arguments.done",
    name: "record_message",
    call_id: id,
    arguments: JSON.stringify({
      name: "Mom",
      reason: "Mom is in the hospital.",
      urgent: true,
      urgent_reason: "hospital",
    }),
  });
}

function playTranscript(call: ReturnType<typeof machine>, id: string, transcript: string) {
  call.streamSid = `MZ${id}`;
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: id,
    delta: "DON=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  return onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: id,
    transcript,
  });
}

function expectDonorReleased(line: string): void {
  const call = machine();
  callerCompleted(call, "giver", line);
  const done = playTranscript(call, "resp_donor", DONOR_X_MONEY);
  assert.equal(hasClear(done), false, line);
  assert.deepEqual(mediaPayloads(done), ["DON="], line);
  assert.equal(call.flags.includes("guardrail"), false, line);
}

function expectDonorRefused(line: string): void {
  const call = machine();
  callerCompleted(call, "giver", line);
  const done = playTranscript(call, "resp_donor", DONOR_X_MONEY);
  assert.equal(hasClear(done), true, line);
  assert.deepEqual(mediaPayloads(done), [], line);
  assert.equal(call.flags.includes("guardrail"), true, line);
  assert.equal(
    call.transcript.some((row) => row.role === "assistant" && row.text === PERSONAL_DETAIL_REFUSAL),
    true,
    line,
  );
}

/** Money lines keep caller-money flags, and possible_scam still beats urgent. */
function assertMoneyBeatsUrgent(line: string): void {
  const call = machine();
  callerCompleted(call, "line", line);
  recordUrgent(call, "call_line");
  assert.equal(call.flags.includes("money_related"), true, line);
  assert.equal(call.flags.includes("possible_scam"), true, line);
  assert.equal(call.flags.includes("urgent"), false, line);
}

/** A line that is not money talk leaves the hospital ask urgent. */
function assertClearUrgent(line: string): void {
  const call = machine();
  callerCompleted(call, "line", line);
  recordUrgent(call, "call_line");
  assert.equal(call.flags.includes("money_related"), false, line);
  assert.equal(call.flags.includes("possible_scam"), false, line);
  assert.equal(call.flags.includes("urgent"), true, line);
}

const GIVE_MONEY_TO = [
  "I want to give money to him.",
  "I want to give money to Owner.",
  "I want to give money to the ministry.",
];

for (const line of GIVE_MONEY_TO) {
  test(`step5: ${line} releases the donor line`, () => {
    expectDonorReleased(line);
  });
}

const NEGATED_GIVING = [
  "I haven't donated.",
  "I didn't donate.",
  "I can't donate.",
  "I cannot donate.",
  "I have not yet donated.",
  "Please do not yet send him money.",
  "I will not yet give to him.",
  "I am not tithing.",
  "I don't want X Money.",
  "I will not financially support him.",
  "I never said I want to give.",
  "I am not sure I want to give money.",
];

for (const line of NEGATED_GIVING) {
  test(`step5: ${line} does not release the donor line`, () => {
    expectDonorRefused(line);
  });
}

const REAL_MONEY_HOMONYM = [
  "live wire transfer",
  "I'll pay you a visit to drop off the cash",
  "He gave. Cash now.",
];

for (const line of REAL_MONEY_HOMONYM) {
  test(`step5: ${line} sets money flags`, () => {
    assertMoneyBeatsUrgent(line);
  });
}

const CLEAR_HOMONYM = [
  "live wire",
  "I'll pay you a visit.",
  "He gave Mom the news. Cash is in the hospital.",
];

for (const line of CLEAR_HOMONYM) {
  test(`step5: allowed ${line} does not set money flags`, () => {
    assertClearUrgent(line);
  });
}

test('step5: completed "I want to donate." then updated "I want to live." keeps money flags and a later hospital ask is not urgent', () => {
  const call = machine();
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "give",
    transcript: "I want to donate.",
  });
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.updated",
    item_id: "give",
    transcript: "I want to live.",
  });
  assert.equal(call.callerAskedToGive, false);
  assert.deepEqual(
    call.transcript.filter((row) => row.role === "caller").map((row) => row.text),
    ["I want to live."],
  );
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
  recordUrgent(call, "call_live");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
  assert.equal(call.flags.includes("urgent"), false);
});

const STILL_MONEY = [
  "Send cash.",
  "Wire me fifty dollars.",
  "Buy gift cards.",
  "Give me your bank account.",
  "Send fifty dollars.",
  "I want to donate.",
];

for (const line of STILL_MONEY) {
  test(`step5: allowed ${line} keeps caller money flags`, () => {
    assertMoneyBeatsUrgent(line);
  });
}

const NEGATED_MONEY = ["I am not donating.", "I didn't donate.", "This is not a donation."];

for (const line of NEGATED_MONEY) {
  test(`step5: ${line} does not set money flags`, () => {
    assertClearUrgent(line);
  });
}

test("step5: allowed message taking still releases audio", () => {
  const call = machine();
  call.streamSid = "MZMSG";
  for (const [id, text] of [
    ["resp_name", "What's your name?"],
    ["resp_callback", "May I have your callback number?"],
    ["resp_confirm", "Is the number you are calling from the best callback?"],
    ["resp_reach", "Can he reach you at the number you are calling from?"],
    ["resp_reason", "What is the reason for your call?"],
  ] as const) {
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
  assert.equal(call.flags.includes("guardrail"), false);
});

test("step5: allowed a catalog greeting releases audio", () => {
  const catalog = loadGreetingCatalog();
  const lines = [...greetingLines(catalog), ...catalog.relatives];
  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.match(line, /Owner's AI Bot/);
    assert.match(line, /this call may be recorded/i);
    assert.match(spokenGreeting(true, line), /Owner/);
  }
  const line = lines[0] ?? "";
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

test("step5: allowed Hi Mom. with stored name Mom", () => {
  assert.equal(answerLeaks("Hi Mom.", "Mom"), false);
  assert.equal(screenAssistant("Hi Mom.", { knownName: "Mom" }).blocked, false);
  assert.equal(answerLeaks("Hi Mom."), true);
  const call = machine("Mom");
  call.streamSid = "MZHI";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_hi",
    delta: "AUD=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_hi",
    transcript: "Hi Mom.",
  });
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["AUD="]);
  assert.equal(call.flags.includes("guardrail"), false);
});

test('step5: allowed donor line after "I want to donate."', () => {
  const call = machine();
  callerCompleted(call, "donate", "I want to donate.");
  const done = playTranscript(call, "resp_donor", DONOR_X_MONEY);
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["DON="]);
  assert.equal(call.flags.includes("guardrail"), false);
  assert.match(call.transcript.map((row) => row.text).join("\n"), /X Money/);
  assert.equal(
    DONOR_X_MONEY,
    "You can give freely to Owner on X at @ExampleOwner through X Money, a secure way to send money.",
  );
});
