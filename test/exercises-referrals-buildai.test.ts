import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExercisesReferralsBuildAiTools } from "../src/tools/exercises-referrals-buildai.js";

const READS = [
  "list_my_custom_exercises", "get_sample_clients_status", "get_my_referred_by", "lookup_referral_code",
  "get_my_gym_checkin_code", "lookup_gym_member", "list_video_minute_packs", "get_build_with_ai_status", "get_ai_build_job",
];
const WRITES = [
  "create_custom_exercise", "update_custom_exercise", "set_diet_plan_marketplace", "set_workout_plan_marketplace",
  "load_sample_clients", "remove_sample_clients", "claim_gym_owner_referral", "start_build_with_ai",
];

type Reg = Record<string, { inputSchema?: { shape?: Record<string, unknown> }; annotations?: Record<string, unknown> }>;

test("all tools register; writes confirm-gated; sample removal destructive", () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerExercisesReferralsBuildAiTools(server);
  const tools = (server as unknown as { _registeredTools: Reg })._registeredTools;
  assert.equal(Object.keys(tools).length, READS.length + WRITES.length);
  for (const n of READS) assert.equal(tools[n]?.annotations?.readOnlyHint, true, `${n} read-only`);
  for (const n of WRITES) {
    const shape = tools[n].inputSchema?.shape ?? (tools[n].inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape?.();
    assert.ok(shape && "confirm" in shape, `${n} must expose confirm`);
  }
  assert.equal(tools.remove_sample_clients.annotations?.destructiveHint, true);
});

test("writes preview without confirm and Build with AI rejects an unknown kind", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerExercisesReferralsBuildAiTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

  const ok = await client.callTool({ name: "start_build_with_ai", arguments: { input: { kind: "PROGRAM", goal: "fat loss" } } });
  assert.match(text(ok), /preview/);
  const bad = await client.callTool({ name: "start_build_with_ai", arguments: { input: { kind: "NOPE" } } }).catch((e) => e);
  assert.ok((bad as { isError?: boolean }).isError || bad instanceof Error);
});
