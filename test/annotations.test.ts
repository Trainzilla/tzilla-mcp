import { test } from "node:test";
import assert from "node:assert/strict";
import { annotateTools, inferAnnotations, withAnnotations, isDestructiveName } from "../src/annotations.js";
import { registerAll } from "../src/index.js";

type Captured = { name: string; ann: Record<string, unknown>; shape: unknown };

function captureAll(): Captured[] {
  const out: Captured[] = [];
  const stub: any = {
    tool: (...args: unknown[]) => {
      const name = String(args[0]);
      // withAnnotations always yields (name, [desc], shape, annotations, cb)
      const ann = args[args.length - 2] as Record<string, unknown>;
      const shape = args[args.length - 3];
      out.push({ name, ann, shape });
    },
    resource: () => undefined,
    prompt: () => undefined,
    registerResource: () => undefined,
    registerPrompt: () => undefined,
  };
  // annotateTools patches stub.tool; it calls the original with the rewritten args.
  annotateTools(stub);
  registerAll(stub);
  return out;
}

test("every tool has a title, openWorldHint=false and an explicit read-only or destructive hint", () => {
  const tools = captureAll();
  assert.ok(tools.length > 400, `expected 400+ tools, got ${tools.length}`);
  const bad = tools.filter(
    (t) =>
      typeof t.ann?.title !== "string" ||
      t.ann.openWorldHint !== false ||
      (t.ann.readOnlyHint !== true && typeof t.ann.destructiveHint !== "boolean"),
  );
  assert.deepEqual(bad.map((t) => t.name), []);
});

test("read-only tools never carry destructiveHint, and writes always say readOnlyHint:false", () => {
  for (const t of captureAll()) {
    if (t.ann.readOnlyHint === true) assert.equal(t.ann.destructiveHint, undefined, t.name);
    else assert.equal(t.ann.readOnlyHint, false, t.name);
  }
});

test("delete / remove / cancel style tools are marked destructive, creates and reads are not", () => {
  const byName = new Map(captureAll().map((t) => [t.name, t.ann]));
  for (const n of ["delete_workout_plan", "delete_diet_plan", "remove_client", "cancel_session", "revoke_api_key", "remove_coach_from_organization"]) {
    assert.equal(byName.get(n)?.destructiveHint, true, n);
  }
  for (const n of ["create_habit", "schedule_session", "send_message_to_client", "create_workout_plan"]) {
    assert.equal(byName.get(n)?.destructiveHint, false, n);
  }
  assert.equal(byName.get("list_clients")?.readOnlyHint, true);
  assert.equal(byName.get("whoami")?.readOnlyHint, true);
});

test("withAnnotations handles every tool() overload and keeps the handler last", () => {
  const cb = () => undefined;
  const shape = { a: 1 };
  for (const args of [
    ["t_read", "d", shape, { readOnlyHint: true }, cb],
    ["t_read", "d", shape, cb],
    ["get_thing", "d", { readOnlyHint: true }, cb],
    ["get_thing", "d", cb],
    ["delete_thing", "d", shape, { readOnlyHint: false }, cb],
  ] as unknown[][]) {
    const out = withAnnotations(args);
    assert.equal(out[out.length - 1], cb);
    assert.equal(out.length, 5);
    assert.equal(typeof (out[3] as any).title, "string");
  }
  assert.equal((withAnnotations(["delete_thing", "d", shape, { readOnlyHint: false }, cb])[3] as any).destructiveHint, true);
  assert.equal((withAnnotations(["get_thing", "d", cb])[3] as any).readOnlyHint, true);
});

test("explicit hints win, and the name rules are conservative", () => {
  assert.equal(inferAnnotations("update_my_contact", { readOnlyHint: false }).destructiveHint, false);
  assert.equal(inferAnnotations("update_my_contact", { destructiveHint: true }).destructiveHint, true);
  assert.equal(isDestructiveName("create_organization"), false);
  assert.equal(isDestructiveName("remove_coach_location_assignment"), true);
});

test("no tool has an input property without a JSON-schema type (shared zod instances are cloned)", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildServer } = await import("../src/index.js");
  const server = buildServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const untyped: string[] = [];
  for (const t of tools) {
    const props = ((t.inputSchema as any)?.properties ?? {}) as Record<string, any>;
    for (const [k, v] of Object.entries(props)) {
      if (!v || (v.type === undefined && !v.anyOf && !v.oneOf && !v.allOf && !v.enum && v.const === undefined)) untyped.push(`${t.name}.${k}`);
    }
  }
  assert.deepEqual(untyped, []);
});
