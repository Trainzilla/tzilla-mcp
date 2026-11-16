import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInsightsCatalogPromoTools } from "../src/tools/insights-catalog-promos.js";

const READS = [
  "get_client_roster", "list_clients_with_declining_recovery", "get_habit_adherence_all_clients", "get_client_workout_streak",
  "list_ai_run_history", "list_client_subscriptions", "get_session", "get_community_unread_count",
  "list_exercise_body_parts", "list_exercise_equipment", "browse_exercise_catalog",
  "list_coupons", "list_challenges", "get_challenge_leaderboard", "list_workout_section_templates",
];
const WRITES = [
  "delete_custom_exercise", "create_coupon", "set_coupon_active", "create_challenge", "set_challenge_active", "delete_challenge",
  "create_workout_section_template", "update_workout_section_template", "delete_workout_section_template",
];

type Reg = Record<string, { inputSchema?: { shape?: Record<string, unknown> }; annotations?: Record<string, unknown> }>;

test("all tools register; writes are confirm-gated; deletes are marked destructive", () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerInsightsCatalogPromoTools(server);
  const tools = (server as unknown as { _registeredTools: Reg })._registeredTools;
  for (const n of [...READS, ...WRITES]) assert.ok(tools[n], `${n} missing`);
  for (const n of READS) assert.equal(tools[n].annotations?.readOnlyHint, true, `${n} should be read-only`);
  for (const n of WRITES) {
    const shape = tools[n].inputSchema?.shape ?? (tools[n].inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape?.();
    assert.ok(shape && "confirm" in shape, `${n} must expose confirm`);
  }
  for (const n of WRITES.filter((w) => w.startsWith("delete_"))) assert.equal(tools[n].annotations?.destructiveHint, true, `${n} destructive`);
});

test("writes preview without calling the API, and bad input is rejected", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerInsightsCatalogPromoTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

  const badCoupon = await client.callTool({ name: "create_coupon", arguments: { input: { code: "x", percentOff: 150 } } });
  assert.equal(badCoupon.isError, true);
  const coupon = await client.callTool({ name: "create_coupon", arguments: { input: { code: "NEWYEAR25", percentOff: 25 } } });
  assert.match(text(coupon), /"status": "preview"/);

  const badDates = await client.callTool({ name: "create_challenge", arguments: { input: { title: "30 day push", startDate: "Dec 1", endDate: "2026-12-30" } } });
  assert.equal(badDates.isError, true);

  const tmpl = await client.callTool({
    name: "create_workout_section_template",
    arguments: { name: "Standard warm-up", section: "WARMUP", exercises: [{ name: "Jumping jacks", reps: "10-15" }] },
  });
  const details = JSON.parse(text(tmpl)).details;
  assert.equal(details.exercises[0].section, "WARMUP");
  assert.equal(details.exercises[0].reps, 15);
  assert.equal(details.exercises[0].repsMin, 10);
  assert.equal(details.exercises[0].sets, 3);

  const empty = await client.callTool({ name: "update_workout_section_template", arguments: { id: "t1" } });
  assert.match(text(empty), /Nothing to change/);
});
