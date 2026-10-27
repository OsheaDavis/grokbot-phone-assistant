import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APPROVED_OPENER, CardStore, canonicalJson, cardHash, validateCard } from "../src/outbound/card.js";
import { EXAMPLE_CARD_HASH, EXAMPLE_CARD_ID, exampleCard, tempCardStore } from "./card-fixture.js";

function withChange(mutate: (c: Record<string, any>) => void): Record<string, unknown> {
  const c = structuredClone(exampleCard()) as Record<string, any>;
  mutate(c);
  return c;
}

test("the committed example card validates and its hash is stable sha256 of canonical JSON", () => {
  const r = validateCard(exampleCard());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hash, EXAMPLE_CARD_HASH);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  // Key order does not change the hash; content does.
  const reordered = Object.fromEntries(Object.entries(exampleCard()).reverse());
  assert.equal(cardHash(reordered), EXAMPLE_CARD_HASH);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("example card carries no phone number; the number is a reference key", () => {
  const raw = fs.readFileSync(path.join(process.cwd(), "examples", "call-cards", "example-returns-v1.json"), "utf8");
  assert.doesNotMatch(raw, /\d(?:[\s().-]*\d){6,}/);
  assert.equal((exampleCard().callee as { numberRef: string }).numberRef, "EXAMPLE_PARTNER");
});

const BAD: [string, (c: Record<string, any>) => void, string][] = [
  ["unknown top key", (c) => (c.extra = 1), "unknown_key"],
  ["recording true", (c) => (c.recording = true), "recording_must_be_false"],
  ["recording missing", (c) => delete c.recording, "recording_must_be_false"],
  ["4 turns", (c) => (c.end.maxTurns = 4), "bad_max_turns"],
  ["120 seconds", (c) => (c.end.maxSeconds = 120), "bad_max_seconds"],
  ["voicemail message", (c) => (c.end.onVoicemail = "leave_message"), "bad_end"],
  ["phone number hidden in a script line", (c) => (c.script.close = "Call 202 555 0100 thanks"), "bad_script_close"],
  ["dotted number in callee name", (c) => (c.callee.name = "Example Partner 202.555.0100"), "bad_callee"],
  ["opener without AI disclosure", (c) => (c.script.opener = "Hi, this is Owner calling for Example Business."), "opener_needs_ai_disclosure"],
  ["callback placeholder without give", (c) => (c.give = []), "callback_not_in_give"],
  ["unknown placeholder", (c) => (c.script.close = "Thanks {name}."), "bad_placeholder"],
  ["give value outside the enum", (c) => (c.give = ["callback_number", "home_address"]), "bad_give"],
  ["take value outside the enum", (c) => (c.take = ["returns_answer", "card_number"]), "bad_take"],
  ["extra allowed topic", (c) => (c.allowedTopics = ["example_returns", "billing"]), "bad_topics"],
  ["donor pitch", (c) => (c.script.close = "Send X Money to help."), "bad_script_close"],
  ["unknown script key", (c) => (c.script.transfer = "Transferring you now."), "bad_script"],
  ["personal cell callee kind", (c) => (c.callee.kind = "personal_cell"), "bad_callee"],
  ["control character", (c) => (c.script.question = "Any returns?\u0007"), "bad_script_question"],
  ["bad id", (c) => (c.id = "../etc/passwd"), "bad_id"],
];
for (const [label, mutate, error] of BAD) {
  test(`card validation rejects: ${label}`, () => {
    const r = validateCard(withChange(mutate));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, error);
  });
}

test("give and take default to none when omitted", () => {
  const r = validateCard(
    withChange((c) => {
      delete c.give;
      delete c.take;
      c.script.opener = "Hi, this is Owner's AI bot, calling for Example Business to see if you have any returns for us.";
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.card.give, []);
    assert.deepEqual(r.card.take, []);
  }
});

test("card store: missing card, tampered file, wrong hash, and number map", () => {
  const t = tempCardStore();
  assert.equal(t.store.load("no-such-card").ok, false);
  assert.deepEqual(t.store.load("no-such-card"), { ok: false, error: "card_missing" });
  assert.deepEqual(t.store.loadPinned(EXAMPLE_CARD_ID, "0".repeat(64)), { ok: false, error: "card_hash_mismatch" });
  assert.deepEqual(t.store.loadPinned(EXAMPLE_CARD_ID, "not-a-hash"), { ok: false, error: "card_hash_mismatch" });
  assert.equal(t.store.loadPinned(EXAMPLE_CARD_ID, t.cardHash).ok, true);
  assert.equal(t.store.resolveNumber("EXAMPLE_PARTNER"), "+12025550100");
  assert.equal(t.store.resolveNumber("OTHER"), null);
  // Tamper: one character changed after approval.
  const file = path.join(t.dir, `${EXAMPLE_CARD_ID}.json`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("good night", "good nite"));
  assert.deepEqual(t.store.loadPinned(EXAMPLE_CARD_ID, t.cardHash), { ok: false, error: "card_hash_mismatch" });
  // Invalid JSON and id/file mismatch.
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(t.store.load(EXAMPLE_CARD_ID), { ok: false, error: "card_invalid" });
  fs.writeFileSync(path.join(t.dir, "other-card.json"), JSON.stringify(exampleCard()));
  assert.deepEqual(t.store.load("other-card"), { ok: false, error: "card_invalid" });
  // A bad number in the map resolves to nothing.
  fs.writeFileSync(path.join(t.dir, "numbers.json"), JSON.stringify({ EXAMPLE_PARTNER: "+19005550100" }));
  assert.equal(t.store.resolveNumber("EXAMPLE_PARTNER"), null);
});

test("card store has no write method", () => {
  const proto = Object.getOwnPropertyNames(CardStore.prototype).sort();
  assert.deepEqual(proto, ["constructor", "load", "loadPinned", "resolveNumber"]);
});

test("example card opener is the approved wording exactly, with the AI hang-up offer", () => {
  const c = exampleCard() as { script: Record<string, string> };
  assert.equal(c.script.opener, "Hi, this is Owner's AI bot, calling for Example Business to see if you have any returns for us. You can reach us at [callback number].");
  assert.equal(c.script.opener, APPROVED_OPENER);
  assert.equal(c.script.aiOffer, "If you would rather not speak with an AI, say so and I will hang up.");
  assert.doesNotMatch(JSON.stringify(c), /may be recorded|reason for this call|6498/i);
});

test("card validation rejects a missing or non-offering AI hang-up line and stray brackets", () => {
  const noOffer = withChange((c) => (c.script.aiOffer = "Thanks for your time."));
  assert.deepEqual(validateCard(noOffer), { ok: false, error: "bad_ai_offer" });
  const missing = withChange((c) => delete c.script.aiOffer);
  assert.deepEqual(validateCard(missing), { ok: false, error: "bad_script_aiOffer" });
  const stray = withChange((c) => (c.script.close = "Thanks [name]."));
  assert.deepEqual(validateCard(stray), { ok: false, error: "bad_placeholder" });
});

test("old opener path is gone: no stage 1 opener module and no Say-then-hangup dial", () => {
  for (const rel of ["src/outbound/opener-twiml.ts", "src/outbound/call.ts"]) {
    assert.equal(fs.existsSync(path.join(process.cwd(), rel)), false, rel);
  }
  const dialer = fs.readFileSync(path.join(process.cwd(), "src/outbound/dialer.ts"), "utf8");
  assert.doesNotMatch(dialer, /openerTwiml|twiml:/);
  const opener = fs.readFileSync(path.join(process.cwd(), "src/outbound/opener.ts"), "utf8");
  assert.doesNotMatch(opener, /export const OPENER|buildOpener/);
});
