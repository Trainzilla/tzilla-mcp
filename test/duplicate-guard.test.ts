// Unit tests for the recent-duplicate guard on create_workout_plan/
// create_diet_plan. Pinned to the real failure it fixes: a chat asked
// "is it done?" twice after a plan was already confirmed, and each
// follow-up re-ran the create tool instead of just checking, producing
// near-identical plans for the same client seconds apart.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pickRecentDuplicate, RecentPlan } from "../src/duplicate-guard.js";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");

const plan = (overrides: Partial<RecentPlan>): RecentPlan => ({
  _id: "plan-1",
  title: "4-Week Home Bodyweight Fat Loss Plan",
  createdAt: new Date(NOW).toISOString(),
  ...overrides,
});

test("returns the existing plan when the same title was just created", () => {
  const created90sAgo = plan({ createdAt: new Date(NOW - 90_000).toISOString() });
  const result = pickRecentDuplicate([created90sAgo], "4-Week Home Bodyweight Fat Loss Plan", NOW);
  assert.equal(result?._id, "plan-1");
});

test("matches regardless of surrounding whitespace or case", () => {
  const created = plan({ title: "  4-week home bodyweight FAT LOSS plan  " });
  const result = pickRecentDuplicate([created], "4-Week Home Bodyweight Fat Loss Plan", NOW);
  assert.ok(result, "expected a case/whitespace-insensitive match");
});

test("ignores a same-titled plan created outside the window", () => {
  const createdHoursAgo = plan({ createdAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() });
  const result = pickRecentDuplicate([createdHoursAgo], "4-Week Home Bodyweight Fat Loss Plan", NOW);
  assert.equal(result, null, "a plan from hours ago is a legitimate re-titled plan, not a duplicate");
});

test("ignores a different title created moments ago", () => {
  const differentTitle = plan({ title: "Advanced Strength Plan", createdAt: new Date(NOW - 5_000).toISOString() });
  const result = pickRecentDuplicate([differentTitle], "4-Week Home Bodyweight Fat Loss Plan", NOW);
  assert.equal(result, null);
});

test("ignores a createdAt that is in the future relative to now (clock skew safety)", () => {
  const future = plan({ createdAt: new Date(NOW + 60_000).toISOString() });
  const result = pickRecentDuplicate([future], "4-Week Home Bodyweight Fat Loss Plan", NOW);
  assert.equal(result, null);
});

test("reproduces the observed incident: 3 near-duplicate plans in 90s collapse to 1", () => {
  const plans = [
    plan({ _id: "p1", createdAt: new Date(NOW - 76_000).toISOString() }),
    plan({ _id: "p2", createdAt: new Date(NOW - 23_000).toISOString() }),
    plan({ _id: "p3", createdAt: new Date(NOW - 1_000).toISOString() }),
  ];
  // A 4th "is it done?" arrives now — it must resolve to the most recent
  // existing plan, not write a 4th one.
  const result = pickRecentDuplicate(plans, plan({}).title, NOW);
  assert.equal(result?._id, "p3");
});

test("respects a custom window", () => {
  const created2MinAgo = plan({ createdAt: new Date(NOW - 2 * 60 * 1000).toISOString() });
  assert.equal(
    pickRecentDuplicate([created2MinAgo], plan({}).title, NOW, 60_000),
    null,
    "outside a 1-minute window",
  );
  assert.ok(
    pickRecentDuplicate([created2MinAgo], plan({}).title, NOW, 5 * 60_000),
    "inside a 5-minute window",
  );
});

test("returns null for an empty plan list", () => {
  assert.equal(pickRecentDuplicate([], "Anything", NOW), null);
});
