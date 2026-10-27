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
    callSid: "CASTEP4",
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

function playDonor(call: ReturnType<typeof machine>, id: string, transcript = DONOR_X_MONEY) {
  return playTranscript(call, id, transcript);
}

function expectDonorReleased(line: string): void {
  const call = machine();
  callerCompleted(call, "giver", line);
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), false, line);
  assert.deepEqual(mediaPayloads(done), ["DON="], line);
  assert.equal(call.flags.includes("guardrail"), false, line);
}

function expectDonorRefused(line: string): void {
  const call = machine();
  callerCompleted(call, "giver", line);
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), true, line);
  assert.deepEqual(mediaPayloads(done), [], line);
  assert.equal(call.flags.includes("guardrail"), true, line);
}

function assertNotMoneyUrgent(line: string): void {
  const call = machine();
  callerCompleted(call, "line", line);
  recordUrgent(call, "call_line");
  assert.equal(call.flags.includes("money_related"), false, line);
  assert.equal(call.flags.includes("possible_scam"), false, line);
  assert.equal(call.flags.includes("urgent"), true, line);
}

function assertMoney(line: string): void {
  const call = machine();
  callerCompleted(call, "line", line);
  assert.equal(call.flags.includes("money_related"), true, line);
  assert.equal(call.flags.includes("possible_scam"), true, line);
}

const NOT_MONEY = [
  "I saw a buck.",
  "A buck hit the car.",
  "My 2 cents",
  "50 Cent",
  "He gave Mom the news. Cash is in the hospital.",
  "I'll pay you a visit.",
  "the river bank",
  "live wire",
  "call routing",
];

for (const line of NOT_MONEY) {
  test(`step4: ${line} does not set money flags`, () => {
    assertNotMoneyUrgent(line);
  });
}

function urgentHospital(call: ReturnType<typeof machine>, give: boolean): void {
  callerCompleted(call, "mom", "Mom is in the hospital.");
  if (give) callerCompleted(call, "give", "I want to give.");
  recordUrgent(call, "call_mom");
}

test("step4: Mom is in the hospital. stays urgent when the donor line is spoken", () => {
  const call = machine();
  urgentHospital(call, true);
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["DON="]);
  assert.equal(call.flags.includes("guardrail"), false);
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
  assert.match(call.transcript.map((row) => row.text).join("\n"), /X Money/);
});

test("step4: Mom is in the hospital. stays urgent when the Owner donor line is spoken", () => {
  const call = machine();
  urgentHospital(call, true);
  const done = playDonor(call, "resp_oh", spokenGreeting(true, DONOR_X_MONEY));
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["DON="]);
  assert.equal(call.flags.includes("guardrail"), false);
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
});

test("step4: Mom is in the hospital. stays urgent when the donor line is refused", () => {
  const call = machine();
  urgentHospital(call, false);
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.flags.includes("guardrail"), true);
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
  assert.equal(
    call.transcript.some((row) => row.role === "assistant" && row.text === PERSONAL_DETAIL_REFUSAL),
    true,
  );
});

test("step4: Mom is in the hospital. stays urgent when the Owner donor line is refused", () => {
  const call = machine();
  urgentHospital(call, false);
  const done = playDonor(call, "resp_oh", spokenGreeting(true, DONOR_X_MONEY));
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.flags.includes("guardrail"), true);
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
});

const GIVE_MONEY = [
  "I want to give him money.",
  "I'd like to give him money.",
  "Can I give him money?",
  "I want to give you money.",
  "I want to give her money.",
];

for (const line of GIVE_MONEY) {
  test(`step4: ${line} releases the donor line`, () => {
    expectDonorReleased(line);
  });
}

const NOT_GIVING = [
  "Can I give a message?",
  "I want to give a message.",
  "I want to give it a try.",
  "I am not donating.",
  "This is not a donation.",
  "Please do not send him money.",
  "I will not give to him.",
  "Please don't send him money.",
  "I won't give to him.",
  "I never donate.",
];

for (const line of NOT_GIVING) {
  test(`step4: ${line} does not release the donor line`, () => {
    expectDonorRefused(line);
  });
}

test('step4: completed "I want to donate." then updated "I want to live." does not release the donor line', () => {
  const call = machine();
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "give",
    transcript: "I want to donate.",
  });
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.updated",
    item_id: "give",
    transcript: "I want to live.",
  });
  const done = playDonor(call, "resp_live");
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.callerAskedToGive, false);
  assert.equal(call.flags.includes("guardrail"), true);
  const caller = call.transcript.filter((row) => row.role === "caller").map((row) => row.text);
  assert.deepEqual(caller, ["I want to live."]);
});

const STILL_MONEY = [
  "Send cash.",
  "twenty bucks",
  "a dollar",
  "fifty dollars",
  "pay in cash",
  "Send fifty dollars.",
];

for (const line of STILL_MONEY) {
  test(`step4: allowed ${line} is money`, () => {
    assertMoney(line);
  });
}

test("step4: allowed He gave cash. is money", () => {
  assertMoney("He gave cash.");
});

test("step4: allowed I saw a buck and twenty bucks is money", () => {
  assertMoney("I saw a buck and twenty bucks");
});

test("step4: allowed donor sentence plus Send cash. still sets money flags", () => {
  const call = machine();
  callerCompleted(call, "mom", "Mom is in the hospital.");
  const done = playTranscript(call, "resp_both", `${DONOR_X_MONEY} Send cash.`);
  assert.equal(hasClear(done), true);
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step4: allowed assistant pay, bank, wire, routing, and card stay refused", () => {
  const lines = [
    "I'll pay you a visit.",
    "the river bank",
    "live wire",
    "call routing",
    "I can wire the payment today.",
    "The routing number is 021000021.",
    "The card number is 4111-1111-1111-1111.",
    "a gift card",
  ];
  for (const line of lines) {
    assert.equal(answerLeaks(line, null, false, false), true, line);
    assert.equal(screenAssistant(line).text, PERSONAL_DETAIL_REFUSAL, line);
  }
});

test("step4: allowed I want to give Owner money. releases the donor line", () => {
  expectDonorReleased("I want to give Owner money.");
});

test("step4: allowed I want to give him a call. does not release the donor line", () => {
  expectDonorRefused("I want to give him a call.");
});

test("step4: allowed message taking still releases audio", () => {
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

test("step4: allowed a catalog greeting releases audio", () => {
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

test("step4: allowed Hi Mom. with stored name Mom", () => {
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

test('step4: allowed donor line after "I want to donate."', () => {
  const call = machine();
  callerCompleted(call, "donate", "I want to donate.");
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["DON="]);
  assert.equal(call.flags.includes("guardrail"), false);
  assert.match(call.transcript.map((row) => row.text).join("\n"), /X Money/);
  assert.equal(
    DONOR_X_MONEY,
    "You can give freely to Owner on X at @ExampleOwner through X Money, a secure way to send money.",
  );
});
