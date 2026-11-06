import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.TZ_ACCESS_TOKEN ||= "x";
const { registerAll } = await import("../src/index.js");
const { REGISTERED_DOCS } = await import("../src/kit.js");

const server = new McpServer({ name: "t", version: "0" });
registerAll(server);
const tools = (server as unknown as { _registeredTools: Record<string, { description?: string; handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;

test("bulk_invite_clients is registered, confirm-gated and matches the backend mutation", () => {
  assert.match(REGISTERED_DOCS.find((d) => d.tool === "bulk_invite_clients")!.doc, /sendBulkInvitations\(input: \$input\)/);
  assert.match(tools["bulk_invite_clients"].description ?? "", /confirm-gated/);
});

test("without confirm it only previews, trimming long notes", async () => {
  const res = await tools["bulk_invite_clients"].handler({
    recipients: [{ email: "a@x.com", name: "A", notes: "x".repeat(200) }, { email: "b@x.com", phone: "+1 555 0100" }],
  }, {});
  const text = res.content[0].text;
  assert.match(text, /"withNotes": 1/);
  assert.match(text, /"withPhone": 1/);
  assert.ok(!text.includes("x".repeat(200)));
});

test("the switch prompt and the shipped skill carry the same instructions", async () => {
  const { SWITCH_INSTRUCTIONS } = await import("../src/tools/switch.js");
  const md = readFileSync(new URL("../skills/switch-to-trainzilla/SKILL.md", import.meta.url), "utf8");
  assert.equal(md.split("-->\n")[1].trim(), SWITCH_INSTRUCTIONS);
  assert.ok(SWITCH_INSTRUCTIONS.includes("bulk_invite_clients"));
});

test("the instructions cover platforms with no export (paste, screenshots, other sources, typing) and never guess emails", async () => {
  const { SWITCH_INSTRUCTIONS } = await import("../src/tools/switch.js");
  assert.match(SWITCH_INSTRUCTIONS, /When there is no export/);
  for (const word of ["Copy and paste", "Screenshots", "payment tool", "Type or dictate", "do not guess or construct emails", "Never scrape", "has no browser", "signs in themselves", "Read-only"]) {
    assert.ok(SWITCH_INSTRUCTIONS.includes(word), word);
  }
  assert.match(SWITCH_INSTRUCTIONS, /never see, ask for or type a password/);
});

test("the instructions name the copy-client-list helper and say a blank cell is a missing value, not a shift", async () => {
  const { SWITCH_INSTRUCTIONS } = await import("../src/tools/switch.js");
  for (const phrase of ["copy client list", "/copy-client-list/", "a blank cell means that client has no value there", "never shift later values left"]) {
    assert.ok(SWITCH_INSTRUCTIONS.includes(phrase), phrase);
  }
});

test("the instructions tell coaches what to do when the list has no email column (Capture this client), and never to invent an email", async () => {
  const { SWITCH_INSTRUCTIONS } = await import("../src/tools/switch.js");
  for (const phrase of ["no email column", "Capture this client", "Never invent an email"]) assert.ok(SWITCH_INSTRUCTIONS.includes(phrase), phrase);
});
