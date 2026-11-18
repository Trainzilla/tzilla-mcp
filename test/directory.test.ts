import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/index.js";
import { DIRECTIVE_WORDS, DIRECTORY_TOOLS, scrubParamText } from "../src/directory.js";

async function list(profile?: "directory") {
  const server = buildServer(profile ? { profile } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tools = (await client.listTools()).tools as any[];
  const prompts = await client.listPrompts().then((r: any) => r.prompts).catch(() => []);
  const instructions = client.getInstructions();
  return { tools, prompts, instructions };
}

test("every allowlisted name exists in the full server (no typos)", async () => {
  const full = new Set((await list()).tools.map((t) => t.name));
  assert.deepEqual(Object.keys(DIRECTORY_TOOLS).filter((n) => !full.has(n)), []);
});

test("directory profile serves exactly the allowlist, with no prompts", async () => {
  const { tools, prompts } = await list("directory");
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(DIRECTORY_TOOLS).sort());
  assert.equal(prompts.length, 0);
  assert.ok(tools.length <= 80, `keep the directory set curated, got ${tools.length}`);
});

test("descriptions and parameter text never name another tool or instruct the model", async () => {
  const { tools } = await list("directory");
  const names = new Set((await list()).tools.map((t) => t.name));
  const bad: string[] = [];
  for (const t of tools) {
    const texts = [t.description ?? "", ...Object.entries((t.inputSchema?.properties ?? {}) as Record<string, any>).map(([, v]) => v.description ?? "")];
    for (const text of texts) {
      if (DIRECTIVE_WORDS.test(text)) bad.push(`${t.name}: directive in "${text.slice(0, 80)}"`);
      for (const n of names) if (n !== t.name && new RegExp(`\\b${n}\\b`).test(text)) bad.push(`${t.name}: names ${n}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("hints are explicit; overwriting, sending and deleting tools are destructive; reads are read-only", async () => {
  const { tools } = await list("directory");
  const by = new Map(tools.map((t) => [t.name, t.annotations]));
  for (const t of tools) {
    assert.equal(t.annotations?.openWorldHint, false, t.name);
    assert.ok(typeof t.annotations?.title === "string", t.name);
    assert.ok(t.annotations.readOnlyHint === true || typeof t.annotations.destructiveHint === "boolean", t.name);
  }
  for (const n of ["update_workout_plan", "update_diet_plan", "update_habit", "send_message_to_client", "send_invitation", "delete_workout_plan", "cancel_session", "set_coach_client_notes"]) {
    assert.equal((by.get(n) as any)?.destructiveHint, true, n);
  }
  for (const n of ["create_workout_plan", "create_habit", "schedule_session", "create_checkin"]) {
    assert.equal((by.get(n) as any)?.destructiveHint, false, n);
  }
  for (const n of ["list_clients", "get_workout_plan", "calc_tdee", "billing_summary"]) assert.equal((by.get(n) as any)?.readOnlyHint, true, n);
});

test("no credential, checkout, payout or health-upload tool is exposed", async () => {
  const { tools } = await list("directory");
  const risky = /api_key|connect_|checkout|bank|payout|stripe|razorpay|webhook|upload|health_report|subscription_tier|secret/;
  assert.deepEqual(tools.map((t) => t.name).filter((n) => risky.test(n)), []);
});

test("every property has a JSON-schema type and confirm is described plainly", async () => {
  const { tools } = await list("directory");
  const untyped: string[] = [];
  for (const t of tools) {
    for (const [k, v] of Object.entries((t.inputSchema?.properties ?? {}) as Record<string, any>)) {
      if (v.type === undefined && !v.anyOf && !v.oneOf && !v.allOf && !v.enum && v.const === undefined) untyped.push(`${t.name}.${k}`);
    }
  }
  assert.deepEqual(untyped, []);
  const w = tools.find((t) => t.name === "create_habit");
  assert.match(w.inputSchema.properties.confirm.description, /preview/);
});

test("scrubParamText drops tool references and directives", () => {
  assert.equal(scrubParamText("Client's User _id (from list_clients)"), "Client's User _id");
  assert.equal(scrubParamText("Date as YYYY-MM-DD. Use list_sessions to find it."), "Date as YYYY-MM-DD.");
});
