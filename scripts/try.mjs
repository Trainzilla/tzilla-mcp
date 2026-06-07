/**
 * Live smoke test against the real backend using the tokens in your .env.
 *
 *   1. cp .env.example .env   and paste TZ_ACCESS_TOKEN (+ TZ_REFRESH_TOKEN)
 *      from the coach web app (localStorage "token" / "refreshToken").
 *   2. npm run build
 *   3. npm run try
 *
 * Read-only: calls whoami, list_clients, and an offline macro calc. Nothing is
 * created or changed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
});

const client = new Client({ name: "try", version: "0.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
} catch (e) {
  console.error(
    "\nCould not start the server. Checklist:\n" +
      "  • Run `npm run build` first\n" +
      "  • Set TZ_ACCESS_TOKEN (and TZ_REFRESH_TOKEN) in .env\n" +
      "  • TZ_API_URL points at the right backend (default = production)\n\n" +
      (e?.message ?? e)
  );
  process.exit(1);
}

async function call(name, args = {}) {
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content ?? []).map((c) => c.text).join("\n");
    console.log(`\n=== ${name} ${JSON.stringify(args)} ===\n${text}`);
  } catch (e) {
    console.log(`\n=== ${name} ${JSON.stringify(args)} ===\nERROR: ${e?.message ?? e}`);
  }
}

await call("whoami");
await call("list_clients", { pageSize: 5 });
await call("calc_macros", { strategy: "STANDARD", calories: 2200, weightKg: 75 });

await client.close();
console.log("\nDone.");
