import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildDoc, REGISTERED_DOCS } from "../src/kit.js";
import { registerExtraTools } from "../src/tools/index.js";

test("buildDoc declares and passes every argument", () => {
  assert.equal(
    buildDoc("query", { field: "dietLogsByDate", args: "clientId: ID!, date: String!", select: "id name" }),
    "query Tool($clientId: ID!, $date: String!) { dietLogsByDate(clientId: $clientId, date: $date) { id name } }"
  );
  assert.equal(buildDoc("mutation", { field: "markAllRead" }), "mutation Tool { markAllRead }");
});

test("buildDoc strips default values from variable declarations", () => {
  assert.equal(
    buildDoc("query", { field: "x", args: "limit: Int = 5", select: "id" }),
    "query Tool($limit: Int) { x(limit: $limit) { id } }"
  );
});

test("extra tools register without name clashes and every write tool is confirm-gated", async () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerExtraTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools;
  const names = Object.keys(tools);
  assert.ok(names.length > 150, `expected 150+ tools, got ${names.length}`);
  const mutations = REGISTERED_DOCS.filter((d) => d.doc.startsWith("mutation")).map((d) => d.tool);
  for (const name of mutations) {
    const shape = tools[name]?.inputSchema?.shape ?? (tools[name]?.inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape?.();
    assert.ok(shape && "confirm" in shape, `${name} must expose confirm`);
  }
});
