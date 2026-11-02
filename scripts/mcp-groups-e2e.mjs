// Drives the built tzilla-mcp over stdio against a local backend. Run from the tzilla-mcp worktree:
//   TZ_API_URL=http://127.0.0.1:4100 TZ_ACCESS_TOKEN=$(cat /tmp/mcp-token.txt) node <path>/mcp-groups-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } });
const c = new Client({ name: "e2e", version: "0" }, { capabilities: {} });
await c.connect(t);
const res = []; const ok = (n, v, e = "") => { res.push([v ? "PASS" : "FAIL", n, v ? "" : e]); if (!v) process.exitCode = 1; };
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content ?? []).map((x) => x.text).join("\n");
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { text, json, err: r.isError };
};
const tools = (await c.listTools()).tools.map((x) => x.name);
const want = ["list_client_groups", "get_client_group", "list_groups_for_client", "create_client_group", "update_client_group", "delete_client_group", "add_group_members", "remove_group_members", "get_group_overview", "list_group_assignments", "assign_workout_to_groups", "assign_diet_to_groups", "assign_habit_to_groups", "message_groups", "schedule_checkin_for_groups", "book_session_for_groups", "undo_group_assignment"];
ok("all 17 group tools are registered", want.every((n) => tools.includes(n)), want.filter((n) => !tools.includes(n)).join());

let r = await call("list_client_groups");
const groups = r.json?.myClientGroups ?? [];
ok("list_client_groups returns the seeded groups", groups.length === 2, r.text.slice(0, 200));
const morning = groups.find((g) => g.name === "Morning batch");
r = await call("get_client_group", { id: morning.id });
ok("get_client_group lists members with names", r.json?.clientGroup?.members?.length === 2, r.text.slice(0, 200));

r = await call("create_client_group", { input: { name: "MCP made" } });
ok("create without confirm only previews", r.json?.status === "preview", r.text.slice(0, 160));
r = await call("create_client_group", { input: { name: "MCP made" }, confirm: true });
const made = r.json?.createClientGroup?.id;
ok("create with confirm creates", !!made, r.text.slice(0, 200));
r = await call("delete_client_group", { id: made, confirm: true });
ok("delete_client_group works", r.json?.deleteClientGroup === true, r.text.slice(0, 200));

r = await call("assign_habit_to_groups", { masterHabitId: "mh1", groupIds: [morning.id] });
ok("assign_habit preview: server-side rows, nothing written", r.json?.status === "preview" && r.json.outcome.rows.length === 2 && r.json.outcome.rows.every((x) => x.status === "WOULD_CREATE"), r.text.slice(0, 300));
r = await call("assign_habit_to_groups", { masterHabitId: "mh1", groupIds: [morning.id], confirm: true });
const aid = r.json?.assignmentId;
ok("assign_habit confirm creates for both", r.json?.createdCount === 2 && !!aid, r.text.slice(0, 300));
const again = await call("assign_habit_to_groups", { masterHabitId: "mh1", groupIds: [morning.id], confirm: true });
ok("asking again straight away returns the same assignment (idempotent)", again.json?.assignmentId === aid, again.text.slice(0, 200));

r = await call("assign_workout_to_groups", { title: "MCP push", startDate: "2026-11-02", exercises: [{ name: "Bench press", sets: 3, reps: 10, restSeconds: 60 }], groupIds: [morning.id] });
ok("assign_workout preview", r.json?.status === "preview" && r.json.outcome.rows.length === 2, r.text.slice(0, 300));
r = await call("assign_workout_to_groups", { title: "MCP push", startDate: "2026-11-02", exercises: [{ name: "Bench press", sets: 3, reps: 10, restSeconds: 60 }], groupIds: [morning.id], confirm: true });
const wid = r.json?.assignmentId;
ok("assign_workout confirm creates two plans", r.json?.createdCount === 2, r.text.slice(0, 300));
r = await call("assign_diet_to_groups", { title: "MCP cut", startDate: "2026-11-02", meals: [{ name: "Oats", scheduledTime: "08:00", order: 1, days: ["MONDAY"], calories: 350, ingredients: [{ name: "Oats", quantity: 50, unit: "g", calories: 190, protein: 7, carbs: 33, fat: 3 }, { name: "Milk", quantity: 200, unit: "ml", calories: 160, protein: 7, carbs: 10, fat: 8 }] }], groupIds: [morning.id], confirm: true });
ok("assign_diet confirm creates two plans", r.json?.createdCount === 2, r.text.slice(0, 300));

r = await call("message_groups", { text: "Hello team", groupIds: [morning.id] });
ok("message_groups preview", r.json?.status === "preview" && r.json.outcome.rows.length === 2, r.text.slice(0, 200));
r = await call("schedule_checkin_for_groups", { input: { dayOfWeek: 1, timeOfDay: "08:30", questions: [{ type: "TEXT", label: "How was your week?", required: true }] }, groupIds: [morning.id], confirm: true });
ok("schedule_checkin_for_groups creates two", r.json?.createdCount === 2, r.text.slice(0, 300));
r = await call("book_session_for_groups", { input: { type: "ONLINE", scheduledStart: "2026-11-09T10:00:00.000Z", scheduledEnd: "2026-11-09T11:00:00.000Z" }, groupIds: [morning.id] });
ok("an online session without a link is refused with the reason", r.err && /meeting link/.test(r.text), r.text.slice(0, 300));

r = await call("get_group_overview", { groupId: morning.id });
ok("get_group_overview returns a row per member", r.json?.groupOverview?.length === 2, r.text.slice(0, 200));
r = await call("list_group_assignments", { groupId: morning.id });
ok("list_group_assignments shows what was given", (r.json?.groupAssignments?.length ?? 0) >= 4, r.text.slice(0, 200));
r = await call("undo_group_assignment", { assignmentId: wid });
ok("undo without confirm only previews", r.json?.status === "preview", r.text.slice(0, 200));
r = await call("undo_group_assignment", { assignmentId: wid, confirm: true });
ok("undo with confirm removes both workout plans", r.json?.undoGroupAssignment?.rows?.every((x) => x.status === "REMOVED"), r.text.slice(0, 300));

console.log(res.map((x) => x.join("  ")).join("\n"));
await c.close();
