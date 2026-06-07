import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = "http://127.0.0.1:8787";

// 1) Auth gate: no key -> 401
const noKey = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
});
console.log(`no-key POST -> HTTP ${noKey.status} ${noKey.status === 401 ? "(gated ✓)" : "(UNEXPECTED)"}`);

// 2) With a tz_ key: full MCP handshake + tools/list (no backend call needed)
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: "Bearer tz_dummy_smoke" } },
});
const client = new Client({ name: "smoke-http", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`HTTP handshake OK — tools: ${tools.length}`);
await client.close();
