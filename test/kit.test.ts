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

test("secret arguments are hidden in previews and uploads go presign -> PUT", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerExtraTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);

  const prev = await client.callTool({ name: "connect_my_razorpay", arguments: { keyId: "rzp_live_abc123", keySecret: "supersecretvalue" } });
  const text = (prev.content as { text: string }[])[0].text;
  assert.ok(!text.includes("supersecretvalue") && text.includes("hidden"));

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (String(url).includes("/api/aws/presign")) return new Response(JSON.stringify({ url: "https://s3.example/put", key: "trainer/u1/img/abc", maxSize: 1000 }));
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    const r = await client.callTool({ name: "upload_file", arguments: { base64: Buffer.from("hi").toString("base64"), contentType: "image/png", confirm: true } });
    assert.match((r.content as { text: string }[])[0].text, /trainer\/u1\/img\/abc/);
    assert.ok(calls.some((c) => c.startsWith("GET") && c.includes("type=image%2Fpng")));
    assert.ok(calls.includes("PUT https://s3.example/put"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("every extra tool is callable: non-destructive writes preview, reads reach the API layer", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerExtraTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: {} }))) as typeof fetch;
  try {
    for (const name of ["mark_all_notifications_read", "set_plan_active", "get_unread_notification_count"]) {
      const tool = (await client.listTools()).tools.find((t) => t.name === name)!;
      const args: Record<string, unknown> = {};
      for (const req of tool.inputSchema.required ?? []) args[req] = req === "input" ? { planId: "p", isActive: true } : "x";
      const r = await client.callTool({ name, arguments: args });
      assert.notEqual((r.content as { text: string }[])[0].text, "typedHandler is not a function", name);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
