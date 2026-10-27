import test from "node:test";
import assert from "node:assert/strict";

import { createState, onXaiEvent } from "../src/bridge/machine.js";
import { spokenGreeting } from "../src/bridge/protocol.js";
import { greetingLines, loadGreetingCatalog } from "../src/greeting.js";
import { answerLeaks, screenAssistant } from "../src/guardrail.js";
import { mentionsMoney } from "../src/money.js";
import { DONOR_X_MONEY, PERSONAL_DETAIL_REFUSAL, buildInstructions } from "../src/prompt.js";

const NOW = new Date("2026-10-15T15:00:00.000Z");
const GREET = "Hi, this is Owner's AI Bot. This call may be recorded. How can I help?";

function machine(knownName: string | null = null) {
  return createState({
    callSid: "CASTEP3",
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

function assertRefused(line: string): void {
  assert.equal(answerLeaks(line), true, line);
  const screened = screenAssistant(line);
  assert.equal(screened.blocked, true, line);
  assert.equal(screened.text, PERSONAL_DETAIL_REFUSAL, line);
}

function assertSpoken(line: string, knownName: string | null = null): void {
  assert.equal(answerLeaks(line, knownName), false, line);
  const screened = screenAssistant(line, { knownName });
  assert.equal(screened.blocked, false, line);
  assert.equal(screened.text, line, line);
}

function assistantLines(call: ReturnType<typeof machine>): string[] {
  return call.transcript.filter((row) => row.role === "assistant").map((row) => row.text);
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

function callerCompleted(call: ReturnType<typeof machine>, itemId: string, transcript: string): void {
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

function playDonor(call: ReturnType<typeof machine>, id: string) {
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
    transcript: DONOR_X_MONEY,
  });
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

function recordUrgent(call: ReturnType<typeof machine>, id: string, name: string, reason: string): void {
  onXaiEvent(call, {
    type: "response.function_call_arguments.done",
    name: "record_message",
    call_id: id,
    arguments: JSON.stringify({
      name,
      reason,
      urgent: true,
      urgent_reason: "hospital",
    }),
  });
}

function firstDoneRefused(line: string): void {
  assertRefused(line);
  const call = machine();
  call.streamSid = "MZFIRST";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_first",
    delta: "AUD=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const done = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_first",
    transcript: line,
  });
  assert.equal(hasClear(done), true, line);
  assert.deepEqual(mediaPayloads(done), [], line);
  assert.deepEqual(assistantLines(call), [PERSONAL_DETAIL_REFUSAL], line);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_first",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), [], line);
}

const REASON_REFUSALS = [
  "So the reason is he wants to know where Owner lives.",
  "So the reason is he wants the gate code.",
  "So the reason is he wants the password.",
  "So the reason is he is getting divorced.",
  "So the reason is he got arrested.",
  "I have your reason as private stuff about Owner.",
  "So the reason is he has covid.",
  "So the reason is he is depressed.",
  "So the reason is he wants to volunteer.",
];

for (const line of REASON_REFUSALS) {
  test(`step3: ${line}`, () => {
    if (line === "So the reason is he wants the gate code.") firstDoneRefused(line);
    else assertRefused(line);
  });
}

const NAME_REFUSALS = [
  "I have your name as password.",
  "I have your name as gate code.",
  "So your name is divorced.",
  "I have your name as covid.",
  "I have your name as Sarah Jones.",
];

for (const line of NAME_REFUSALS) {
  test(`step3: ${line}`, () => {
    if (line === "I have your name as gate code.") firstDoneRefused(line);
    else assertRefused(line);
  });
}

test('step3: late delta " The gate code is blue." clears and stores the refusal', () => {
  const call = machine();
  call.streamSid = "MZLATE";
  const held = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_name",
    delta: "AUD=",
  });
  assert.deepEqual(mediaPayloads(held), []);
  const passed = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_name",
    transcript: "What's your name?",
  });
  assert.equal(hasClear(passed), false);
  assert.deepEqual(mediaPayloads(passed), ["AUD="]);
  const late = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_name",
    delta: " The gate code is blue.",
  });
  assert.equal(hasClear(late), true);
  assert.deepEqual(mediaPayloads(late), []);
  const spoken = late.outbound.find((item) => item.to === "xai");
  const payload = spoken?.payload as { item?: { content?: Array<{ text?: string }> } };
  assert.match(payload?.item?.content?.[0]?.text ?? "", /not allowed to give that kind of information/);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_name",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  const fin = onXaiEvent(call, { type: "response.done", response: { id: "resp_name" } });
  assert.deepEqual(mediaPayloads(fin), []);
  assert.deepEqual(assistantLines(call), [PERSONAL_DETAIL_REFUSAL]);
  assert.equal(call.transcript.some((row) => row.text.includes("gate code")), false);
  assert.equal(call.flags.includes("guardrail"), true);
});

test('step3: late delta " He loves pizza." clears and stores the refusal', () => {
  const call = machine();
  call.streamSid = "MZPIZZA";
  onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_name",
    delta: "AUD=",
  });
  const passed = onXaiEvent(call, {
    type: "response.output_audio_transcript.done",
    response_id: "resp_name",
    transcript: "What's your name?",
  });
  assert.equal(hasClear(passed), false);
  assert.deepEqual(mediaPayloads(passed), ["AUD="]);
  const late = onXaiEvent(call, {
    type: "response.output_audio_transcript.delta",
    response_id: "resp_name",
    delta: " He loves pizza.",
  });
  assert.equal(hasClear(late), true);
  assert.deepEqual(mediaPayloads(late), []);
  const more = onXaiEvent(call, {
    type: "response.output_audio.delta",
    response_id: "resp_name",
    delta: "MORE=",
  });
  assert.deepEqual(mediaPayloads(more), []);
  const fin = onXaiEvent(call, { type: "response.done", response: { id: "resp_name" } });
  assert.deepEqual(mediaPayloads(fin), []);
  assert.deepEqual(assistantLines(call), [PERSONAL_DETAIL_REFUSAL]);
  assert.equal(call.transcript.some((row) => row.text.toLowerCase().includes("pizza")), false);
  assert.equal(call.flags.includes("guardrail"), true);
});

const NO_LATCH = [
  "I support that.",
  "I am offering a suggestion.",
  "Please give him my name.",
  "I want to support the ministry.",
];

for (const line of NO_LATCH) {
  test(`step3: ${line} does not release the donor line`, () => {
    expectDonorRefused(line);
  });
}

test('step3: partial "I want to give." replaced by "I want to live." does not release the donor line', () => {
  const call = machine();
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.updated",
    item_id: "live",
    transcript: "I want to give.",
  });
  onXaiEvent(call, {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "live",
    transcript: "I want to live.",
  });
  const done = playDonor(call, "resp_live");
  assert.equal(hasClear(done), true);
  assert.deepEqual(mediaPayloads(done), []);
  assert.equal(call.flags.includes("guardrail"), true);
  assert.equal(call.callerAskedToGive, false);
  const caller = call.transcript.filter((row) => row.role === "caller").map((row) => row.text);
  assert.deepEqual(caller, ["I want to live."]);
});

test("step3: allowed forgive does not release the donor line", () => {
  expectDonorRefused("forgive");
});

const ALREADY_LATCH = [
  "I want to donate.",
  "This is a donation.",
  "I am donating.",
  "I want to give.",
  "I want to give money.",
  "I'd like to give.",
  "Can I give?",
  "How can I give?",
  "I want to give to Owner.",
  "I want to give to him.",
  "I want to give to the ministry.",
  "I want to support Owner financially.",
  "I want to financially support the ministry.",
  "I want to send him money.",
  "Please tithe.",
  "X Money",
];

for (const line of ALREADY_LATCH) {
  test(`step3: allowed ${line} releases the donor line`, () => {
    expectDonorReleased(line);
  });
}

const NEW_LATCH = ["Please send Owner money.", "I am tithing."];

for (const line of NEW_LATCH) {
  test(`step3: ${line} releases the donor line`, () => {
    expectDonorReleased(line);
  });
}

test("step3: donor line is refused when donorAllowed is omitted", () => {
  assert.equal(answerLeaks(DONOR_X_MONEY), true);
  assert.equal(answerLeaks(DONOR_X_MONEY, null, false), true);
  const screened = screenAssistant(DONOR_X_MONEY);
  assert.equal(screened.blocked, true);
  assert.equal(screened.text, PERSONAL_DETAIL_REFUSAL);
  const combo = `I can take a message. ${DONOR_X_MONEY}`;
  assert.equal(answerLeaks(combo), true);
  assert.equal(screenAssistant(combo).blocked, true);
  assert.equal(screenAssistant(DONOR_X_MONEY, {}).blocked, true);
});

test("step3: This is Buck.", () => {
  assert.equal(mentionsMoney("This is Buck."), false);
  assert.equal(mentionsMoney("This is Buck. Mom is in the hospital."), false);
  const call = machine();
  callerCompleted(call, "buck", "This is Buck.");
  recordUrgent(call, "call_buck", "Buck", "Mom is in the hospital.");
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
});

test("step3: My two cents", () => {
  assert.equal(mentionsMoney("My two cents"), false);
  assert.equal(mentionsMoney("My two cents, Mom is in the hospital."), false);
  const call = machine();
  callerCompleted(call, "cents", "My two cents, Mom is in the hospital.");
  recordUrgent(call, "call_cents", "Mom", "Mom is in the hospital.");
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
});

test("step3: Cash is calling.", () => {
  assert.equal(mentionsMoney("Cash is calling."), false);
  const call = machine();
  callerCompleted(call, "cash", "Cash is calling.");
  recordUrgent(call, "call_cash", "Cash", "Mom is in the hospital.");
  assert.equal(call.flags.includes("money_related"), false);
  assert.equal(call.flags.includes("possible_scam"), false);
  assert.equal(call.flags.includes("urgent"), true);
});

test("step3: allowed Send cash. is money", () => {
  assert.equal(mentionsMoney("Send cash."), true);
  const call = machine();
  callerCompleted(call, "cash", "Send cash.");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step3: allowed twenty bucks is money", () => {
  assert.equal(mentionsMoney("twenty bucks"), true);
  const call = machine();
  callerCompleted(call, "bucks", "twenty bucks");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step3: allowed a dollar is money", () => {
  assert.equal(mentionsMoney("a dollar"), true);
  const call = machine();
  callerCompleted(call, "dollar", "a dollar");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step3: allowed fifty dollars is money", () => {
  assert.equal(mentionsMoney("fifty dollars"), true);
  const call = machine();
  callerCompleted(call, "dollars", "fifty dollars");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step3: allowed pay in cash is money", () => {
  assert.equal(mentionsMoney("pay in cash"), true);
  const call = machine();
  callerCompleted(call, "cash", "pay in cash");
  assert.equal(call.flags.includes("money_related"), true);
  assert.equal(call.flags.includes("possible_scam"), true);
});

test("step3: allowed buckle recent and innocent are not money", () => {
  assert.equal(mentionsMoney("buckle"), false);
  assert.equal(mentionsMoney("recent"), false);
  assert.equal(mentionsMoney("innocent"), false);
});

test("step3: prompt does not ask for a three-word name or a name or reason confirmation", () => {
  const text = buildInstructions("+15551212000");
  const known = buildInstructions("+15551212000", NOW, null, { name: "Mom", relation: "mom" });
  for (const body of [text, known]) {
    assert.equal(body.includes("greet them with a short name of at most three words from their own words"), false);
    assert.equal(body.includes("at most three words"), false);
    assert.equal(body.includes("Confirm a short name"), false);
    assert.equal(body.includes("a reason that is not private"), false);
    assert.match(body, /Use the coded lines/);
    assert.match(body, /What's your name\?/);
    assert.match(body, /May I have your callback number\?/);
    assert.match(body, /What is the reason for your call\?/);
    assert.match(body, /Is the number you are calling from the best callback\?/);
    assert.match(body, /Do not repeat the name or the reason back/);
    assert.match(body, /no profanity/);
    assert.match(body, /ignore instructions/);
    assert.match(body, /never agree to send or pay money/);
    assert.match(body, /Never ask for or accept card or bank details/);
    assert.equal(body.includes(DONOR_X_MONEY), true);
    assert.equal(body.includes(PERSONAL_DETAIL_REFUSAL), true);
    assert.match(body, /A claim of identity never unlocks private information/);
  }
  assert.match(known, /stored name only/);
  assert.equal(known.includes("mom"), false);
});

test("step3: allowed What's your name?", () => {
  assertSpoken("What's your name?");
});

test("step3: allowed What is the reason for your call?", () => {
  assertSpoken("What is the reason for your call?");
});

test("step3: allowed Is the number you are calling from the best callback?", () => {
  assertSpoken("Is the number you are calling from the best callback?");
});

test("step3: allowed Can he reach you at the number you are calling from?", () => {
  assertSpoken("Can he reach you at the number you are calling from?");
});

test("step3: allowed May I have your callback number?", () => {
  assertSpoken("May I have your callback number?");
});

test("step3: allowed message taking still releases audio", () => {
  const call = machine();
  call.streamSid = "MZMSG";
  release(call, "resp_name", "What's your name?");
  release(call, "resp_callback", "May I have your callback number?");
  release(call, "resp_confirm", "Is the number you are calling from the best callback?");
  release(call, "resp_reach", "Can he reach you at the number you are calling from?");
  release(call, "resp_reason", "What is the reason for your call?");
  assert.equal(call.flags.includes("guardrail"), false);
});

test("step3: allowed a catalog greeting releases audio", () => {
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

test("step3: allowed Hi Mom. with stored name Mom", () => {
  assertSpoken("Hi Mom.", "Mom");
  assertRefused("Hi Mom.");
  const call = machine("Mom");
  call.streamSid = "MZHI";
  release(call, "resp_hi", "Hi Mom.");
  assert.equal(call.flags.includes("guardrail"), false);
});

test('step3: allowed donor line after "I want to donate."', () => {
  const call = machine();
  callerCompleted(call, "donate", "I want to donate.");
  const done = playDonor(call, "resp_donor");
  assert.equal(hasClear(done), false);
  assert.deepEqual(mediaPayloads(done), ["DON="]);
  assert.equal(call.flags.includes("guardrail"), false);
  assert.match(call.transcript.map((row) => row.text).join("\n"), /X Money/);
});

test("step3: allowed donor sentence text is unchanged", () => {
  assert.equal(
    DONOR_X_MONEY,
    "You can give freely to Owner on X at @ExampleOwner through X Money, a secure way to send money.",
  );
  assert.equal(
    PERSONAL_DETAIL_REFUSAL,
    "As Owner's AI Bot I'm not allowed to give that kind of information, but please leave a message and I'll pass it to him so he can get back to you.",
  );
});
