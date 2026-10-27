import test from "node:test";
import assert from "node:assert/strict";

import { purgeCalls, CallStore } from "../src/store/calls.js";
import { sampleEntry, tempStore } from "./fixtures.js";

const DAY = 24 * 60 * 60 * 1000;

test("purges entries older than 30 days and keeps the boundary", () => {
  const now = Date.parse("2026-10-10T00:00:00.000Z");
  const old = sampleEntry({
    id: "old",
    end_time: new Date(now - 30 * DAY - 1).toISOString(),
  });
  const edge = sampleEntry({
    id: "edge",
    end_time: new Date(now - 30 * DAY).toISOString(),
  });
  const recent = sampleEntry({
    id: "recent",
    end_time: new Date(now - DAY).toISOString(),
  });
  const kept = purgeCalls([old, edge, recent], now, 30);
  assert.deepEqual(
    kept.map((call) => call.id),
    ["edge", "recent"],
  );
});

test("the call log drops expired entries on read", async () => {
  const now = Date.parse("2026-10-10T00:00:00.000Z");
  const store = tempStore(30);
  await store.append(
    sampleEntry({ id: "old", end_time: new Date(now - 31 * DAY).toISOString() }),
    now,
  );
  await store.append(
    sampleEntry({ id: "recent", end_time: new Date(now - DAY).toISOString() }),
    now,
  );
  const rows = await store.readSince(undefined, now);
  assert.deepEqual(
    rows.map((call) => call.id),
    ["recent"],
  );
});

test("readSince filters on end time", async () => {
  const store: CallStore = tempStore();
  await store.append(sampleEntry({ id: "a", end_time: "2026-10-01T00:00:00.000Z" }));
  await store.append(sampleEntry({ id: "b", end_time: "2026-10-09T00:00:00.000Z" }));
  const rows = await store.readSince("2026-10-08T00:00:00.000Z", Date.parse("2026-10-10T00:00:00.000Z"));
  assert.deepEqual(
    rows.map((call) => call.id),
    ["b"],
  );
});
