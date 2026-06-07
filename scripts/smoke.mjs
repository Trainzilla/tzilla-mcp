import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, TZ_ACCESS_TOKEN: "dummy-smoke-token" },
});

const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const { resourceTemplates = [] } = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
console.log(`RESOURCE TEMPLATES (${resourceTemplates.length}): ${resourceTemplates.map((r) => r.uriTemplate).join(", ")}`);

const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] }));
console.log(`PROMPTS (${prompts.length}): ${prompts.map((p) => p.name).join(", ")}`);

// Verify a write tool returns a preview (no confirm) without hitting the API.
const res = await client.callTool({ name: "create_habit", arguments: { clientId: "demo", name: "Drink water" } });
const text = res.content?.[0]?.text ?? "";
console.log(`create_habit (no confirm) -> ${text.includes('"status": "preview"') ? "PREVIEW ✓" : "unexpected: " + text.slice(0, 80)}`);

await client.close();
