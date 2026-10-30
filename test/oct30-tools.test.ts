// The Oct 30 features (Library, default client units, weekly message series, check-in interval) are reachable
// from MCP, and every write is confirm-gated. Documents themselves are checked against the backend schema by
// scripts/validate-docs.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.TZ_ACCESS_TOKEN ||= "x";
const { registerAll } = await import("../src/index.js");
const { REGISTERED_DOCS } = await import("../src/kit.js");

const server = new McpServer({ name: "t", version: "0" });
registerAll(server);
const docs = new Map(REGISTERED_DOCS.map((d) => [d.tool, d.doc]));

test("library, units and weekly-series tools are registered", () => {
  for (const name of [
    "list_library_items", "create_library_item", "update_library_item", "delete_library_item",
    "get_client_unit_default", "set_client_unit_default", "create_weekly_message_series",
  ]) assert.ok(docs.has(name), `${name} missing`);
});

test("weekly series, workflows and check-in schedules carry the new fields", () => {
  assert.match(docs.get("create_weekly_message_series")!, /sequence \{ weekday planIds messages \}/);
  assert.match(docs.get("update_workflow")!, /sequence \{ weekday planIds messages \}/);
  assert.match(docs.get("upsert_checkin_schedule")!, /intervalWeeks/);
  assert.match(docs.get("list_checkin_schedules")!, /intervalWeeks anchorDate timeZone/);
});

test("write tools say they are confirm-gated", () => {
  const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
  for (const name of ["create_library_item", "update_library_item", "delete_library_item", "set_client_unit_default", "create_weekly_message_series"]) {
    assert.match(tools[name].description ?? "", /confirm-gated/, name);
  }
});
