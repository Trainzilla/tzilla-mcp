import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProgramTools } from "../src/tools/programs.js";

const NAMES = [
  "list_programs", "get_program", "create_program", "update_program", "archive_program", "enroll_clients_in_program",
  "undo_program_assignment", "push_program_to_clients", "list_program_enrollments", "get_program_enrollment",
  "pause_program_enrollment", "resume_program_enrollment", "shift_program_enrollment_start", "cancel_program_enrollment",
  "edit_program_enrollment", "list_program_occurrences", "retry_program_occurrence",
];

test("program tools register, and every write tool is confirm-gated", () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerProgramTools(server);
  const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })._registeredTools;
  for (const n of NAMES) assert.ok(tools[n], `${n} missing`);
  const readOnly = new Set(["list_programs", "get_program", "list_program_enrollments", "get_program_enrollment", "list_program_occurrences"]);
  for (const n of NAMES.filter((x) => !readOnly.has(x))) {
    const shape = tools[n].inputSchema?.shape ?? (tools[n].inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape?.();
    assert.ok(shape && "confirm" in shape, `${n} must expose confirm`);
  }
});

test("enrolling needs someone to enrol, and previews without writing", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerProgramTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const none = await client.callTool({ name: "enroll_clients_in_program", arguments: { programId: "p", startDate: "2026-12-01" } });
  assert.equal(none.isError, true);
  const bad = await client.callTool({ name: "enroll_clients_in_program", arguments: { programId: "p", startDate: "Dec 1", clientIds: ["c"] } });
  assert.equal(bad.isError, true);
  const preview = await client.callTool({ name: "create_program", arguments: { input: { name: "x", lengthDays: 28 } } });
  assert.match((preview.content as { text: string }[])[0].text, /"status": "preview"/);
});
