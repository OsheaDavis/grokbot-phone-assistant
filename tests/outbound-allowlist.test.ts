import test from "node:test";
import { EXAMPLE_CARD_HASH, EXAMPLE_CARD_ID, tempCardStore } from "./card-fixture.js";
import assert from "node:assert/strict";

import { ApprovalStore, createApprovalCard, type ApprovalCardInput } from "../src/outbound/approval.js";
import { MAX_APPROVAL_MS } from "../src/outbound/constants.js";
import { allowlistRefusal, loadOutboundAllowlist } from "../src/outbound/dial-allowlist.js";
import { dialApprovedCall, type OutboundCallRequest, type OutboundTwilioClient } from "../src/outbound/dialer.js";

// Fictional 555-01xx numbers only.
const ALLOWED = "+12025550100";
const REFUSED = "+12025550199";
const BEARER = "allowlist-test-bearer";
const AUTH = `Bearer ${BEARER}`;
const BASE: NodeJS.ProcessEnv = { OUTBOUND_ENABLED: "1", OUTBOUND_BEARER_TOKEN: BEARER, OUTBOUND_CALLBACK_NUMBER: "+12025550142" };
const ON: NodeJS.ProcessEnv = { ...BASE, OUTBOUND_ALLOWLIST: ALLOWED };
/** 2:00 PM Eastern. */
const NOW = Date.parse("2026-07-15T18:00:00.000Z");

const MALFORMED = [
  "2025550100",
  "+1 202 555 0100",
  "+15555550100",
  "+12025550100,",
  ",",
  "+12025550100;+12025550199",
  "+12025550100,+12025550199",
  "+12025550100,garbage",
  "+19005550100",
  `${ALLOWED},${"9".repeat(300)}`,
];

function input(number: string): ApprovalCardInput {
  return { business: "Dentist", number, purpose: "book a cleaning", slotNames: [], ttlMs: MAX_APPROVAL_MS, card: { id: EXAMPLE_CARD_ID, hash: EXAMPLE_CARD_HASH } };
}

function fakeClient(): { client: OutboundTwilioClient; calls: OutboundCallRequest[] } {
  const calls: OutboundCallRequest[] = [];
  return {
    calls,
    client: { calls: { async create(r) { calls.push(r); return { sid: `CA${"0".repeat(31)}${calls.length}` }; } } },
  };
}

test("allowlist loader: one valid number loads, duplicates and spaces collapse", () => {
  assert.deepEqual(loadOutboundAllowlist(ON), { ok: true, numbers: [ALLOWED] });
  assert.deepEqual(loadOutboundAllowlist({ OUTBOUND_ALLOWLIST: ` ${ALLOWED} , ${ALLOWED}` }), { ok: true, numbers: [ALLOWED] });
});

test("allowlist loader: missing or empty fails closed", () => {
  for (const env of [{}, { OUTBOUND_ALLOWLIST: "" }, { OUTBOUND_ALLOWLIST: "   " }]) {
    assert.deepEqual(loadOutboundAllowlist(env), { ok: false, reason: "allowlist_missing" });
    assert.equal(allowlistRefusal(ALLOWED, env), "allowlist_missing");
  }
});

test("allowlist loader: malformed fails closed for every number", () => {
  for (const raw of MALFORMED) {
    const env = { OUTBOUND_ALLOWLIST: raw };
    assert.deepEqual(loadOutboundAllowlist(env), { ok: false, reason: "allowlist_malformed" }, raw);
    assert.equal(allowlistRefusal(ALLOWED, env), "allowlist_malformed", raw);
  }
});

test("allowlist: allowed passes, other number refused", () => {
  assert.equal(allowlistRefusal(ALLOWED, ON), null);
  assert.equal(allowlistRefusal(REFUSED, ON), "not_allowlisted");
});

test("approval: allowlisted number gets a card", () => {
  const r = createApprovalCard({ store: new ApprovalStore(), input: input(ALLOWED), bearerHeader: AUTH, env: ON, now: NOW });
  assert.equal(r.ok, true);
});

test("approval: refuses non-allowlisted, missing, empty and malformed without echoing the list", () => {
  const cases: Array<[NodeJS.ProcessEnv, string, string]> = [
    [ON, REFUSED, "not_allowlisted"],
    [BASE, ALLOWED, "allowlist_missing"],
    [{ ...BASE, OUTBOUND_ALLOWLIST: "" }, ALLOWED, "allowlist_missing"],
    ...MALFORMED.map((m): [NodeJS.ProcessEnv, string, string] => [{ ...BASE, OUTBOUND_ALLOWLIST: m }, ALLOWED, "allowlist_malformed"]),
  ];
  for (const [env, number, reason] of cases) {
    const store = new ApprovalStore();
    const r = createApprovalCard({ store, input: input(number), bearerHeader: AUTH, env, now: NOW });
    assert.deepEqual(r, { ok: false, reason });
    assert.ok(!JSON.stringify(r).includes("555"));
  }
});

async function dialWith(cardEnv: NodeJS.ProcessEnv, dialEnv: NodeJS.ProcessEnv) {
  const store = new ApprovalStore();
  const fake = fakeClient();
  const card = createApprovalCard({ store, input: input(ALLOWED), bearerHeader: AUTH, env: cardEnv, now: NOW });
  assert.ok(card.ok);
  const result = await dialApprovedCall({
    store,
    client: fake.client,
    request: { approvalId: card.approval.id, code: card.code, confirmNumber: ALLOWED, bearerHeader: AUTH },
    now: NOW,
    env: dialEnv,
    schedule: () => {},
    stage2: { cards: tempCardStore(ALLOWED).store, baseUrl: "https://example.com" },
  });
  return { result, fake };
}

test("dialer: allowlisted number dials once", async () => {
  const { result, fake } = await dialWith(ON, ON);
  assert.equal(result.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.to, ALLOWED);
});

test("dialer: re-checks the allowlist; a card made under an old list cannot dial", async () => {
  const cases: Array<[NodeJS.ProcessEnv, string]> = [
    [{ ...BASE, OUTBOUND_ALLOWLIST: REFUSED }, "not_allowlisted"],
    [BASE, "allowlist_missing"],
    [{ ...BASE, OUTBOUND_ALLOWLIST: "" }, "allowlist_missing"],
    [{ ...BASE, OUTBOUND_ALLOWLIST: "+12025550100,+12025550199" }, "allowlist_malformed"],
    [{ ...BASE, OUTBOUND_ALLOWLIST: "not-a-number" }, "allowlist_malformed"],
  ];
  for (const [dialEnv, reason] of cases) {
    const { result, fake } = await dialWith(ON, dialEnv);
    assert.deepEqual(result, { ok: false, reason });
    assert.equal(fake.calls.length, 0);
  }
});
