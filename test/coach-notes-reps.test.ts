// Coach notes tools, rep ranges, and supersetGroup on plan reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.TZ_ACCESS_TOKEN ||= "x";
const { registerAll, parseReps, normalizeExercises } = await import("../src/index.js");
const { REGISTERED_DOCS } = await import("../src/kit.js");

const server = new McpServer({ name: "t", version: "0" });
registerAll(server);
const docs = new Map(REGISTERED_DOCS.map((d) => [d.tool, d.doc]));
const tools = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;

test("coach notes tools exist; the write is confirm-gated", () => {
  assert.match(docs.get("get_coach_client_notes")!, /coachClientNotes\(clientId: \$clientId\)/);
  assert.match(docs.get("set_coach_client_notes")!, /setCoachClientNotes/);
  assert.match(tools["set_coach_client_notes"].description ?? "", /confirm-gated/);
});

test("parseReps keeps ranges instead of collapsing to the top number", () => {
  assert.deepEqual(parseReps("8-10"), { reps: 10, repsMin: 8 });
  assert.deepEqual(parseReps("12–15"), { reps: 15, repsMin: 12 });
  assert.deepEqual(parseReps("10 to 8"), { reps: 10, repsMin: 8 });
  assert.deepEqual(parseReps(12), { reps: 12 });
  assert.deepEqual(parseReps("12"), { reps: 12 });
  assert.deepEqual(parseReps(10, 8), { reps: 10, repsMin: 8 });
  assert.deepEqual(parseReps("10-10"), { reps: 10 });
  assert.deepEqual(parseReps(undefined), { reps: 10 });
});

test("normalizeExercises carries repsMin and supersetGroup through", () => {
  const [a, b] = normalizeExercises([
    { name: "Squat", sets: 3, reps: "8-10", supersetGroup: " A " },
    { name: "Row", sets: 3, reps: 10, supersetGroup: "" },
  ]);
  assert.equal(a.reps, 10);
  assert.equal(a.repsMin, 8);
  assert.equal(a.supersetGroup, "A");
  assert.ok(!("repsMin" in b) && !("supersetGroup" in b));
});
