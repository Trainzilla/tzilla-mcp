// History import tools: unit conversion, answer-label mapping, confirm gating, registered documents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.TZ_ACCESS_TOKEN ||= "x";
const { registerAll } = await import("../src/index.js");
const { REGISTERED_DOCS } = await import("../src/kit.js");
const { toProgressEntry, mapAnswers, momentFor } = await import("../src/tools/history-import.js");

const server = new McpServer({ name: "t", version: "0" });
registerAll(server);
const tools = (server as unknown as { _registeredTools: Record<string, { description?: string; handler: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;

test("history tools are registered with documents the backend schema can validate", () => {
  for (const name of ["import_checkin_history", "add_client_progress_history", "list_pending_client_progress"]) {
    assert.ok(tools[name], `${name} missing`);
    assert.ok(REGISTERED_DOCS.some((d) => d.tool === name), `${name} has no document`);
  }
  assert.match(tools["add_client_progress_history"].description ?? "", /onboarding/);
});

test("imperial rows are converted to the API's kg and cm", () => {
  const e = toProgressEntry({ date: "2026-03-02", weight: 154, measurements: { chest: 40, arm: 13, thigh: 23 }, notes: "wk1" }, "imperial", ["trainer/c/images/a.jpg"]);
  assert.equal(e.dateISO, "2026-03-02");
  assert.equal(e.weightKg, 69.9);
  assert.deepEqual(e.measurements, { chestCm: 101.6, armCm: 33, thighCm: 58.4 });
  assert.deepEqual(e.imageUrls, ["trainer/c/images/a.jpg"]);
});

test("metric rows pass through; empty parts are left out", () => {
  assert.deepEqual(toProgressEntry({ date: "2026-03-02", weight: 70 }, "metric", []), { dateISO: "2026-03-02", weightKg: 70 });
});

test("answers map to question ids by label, ignoring case; unknown labels are reported", () => {
  const r = mapAnswers([{ id: "q1", label: "Weight (lb)" }, { id: "q2", label: "Energy" }], { "weight (LB)": 154, Energy: "7", Sleep: "8h" });
  assert.deepEqual(r.answers, [{ questionId: "q1", value: "154" }, { questionId: "q2", value: "7" }]);
  assert.deepEqual(r.unmatched, ["Sleep"]);
});

test("a past day is dated noon UTC; today never lands in the future", () => {
  const now = Date.parse("2026-11-05T08:00:00Z");
  assert.equal(momentFor("2026-03-02", now), "2026-03-02T12:00:00.000Z");
  assert.equal(new Date(momentFor("2026-11-05", now)).getTime() < now, true);
});

test("both batch tools only preview without confirm", async () => {
  const p = await tools["add_client_progress_history"].handler({ clientId: "c1", units: "metric", entries: [{ date: "2026-03-02", weight: 70 }], confirm: false }, {});
  assert.match(p.content[0].text, /"status": "preview"/);
  const q = await tools["import_checkin_history"].handler({ clientId: "c1", checkins: [{ date: "2026-03-02", answers: { a: "1" } }], confirm: false }, {});
  assert.match(q.content[0].text, /"status": "preview"/);
});
