// The hosted MCP calls the GraphQL API once per tool call. A hung or rate-limited hop used to hang forever or
// surface as "Empty GraphQL response (HTTP 429)"; a gateway (Composio) then reported it as a timeout.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { gql, isMutation, runWithToken } from "../src/client.js";
import { instrumentHandler } from "../src/observability.js";

const realFetch = globalThis.fetch;
let calls: number;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that never answers until its AbortSignal fires, like a hung upstream. */
const hang = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    // AbortSignal.timeout() timers are unref'd and a stub has no socket, so hold the event loop open ourselves.
    const keepAlive = setTimeout(() => {}, 5_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal!.reason);
    });
  });

beforeEach(() => {
  calls = 0;
  process.env.TZ_MCP_RETRY_DELAY_MS = "0";
  process.env.TZ_MCP_REQUEST_TIMEOUT_MS = "30";
  process.env.TZ_MCP_MUTATION_TIMEOUT_MS = "30";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const run = <T>(q: string) => runWithToken("tz_test", () => gql<T>(q));

test("isMutation tells mutations from queries, ignoring leading comments", () => {
  assert.equal(isMutation("mutation M { a }"), true);
  assert.equal(isMutation("  # note\n mutation M { a }"), true);
  assert.equal(isMutation("query Q { a }"), false);
  assert.equal(isMutation("{ a }"), false);
});

test("a rate-limited query is retried once and then succeeds", async () => {
  globalThis.fetch = (async () => (++calls === 1 ? json(429, { message: "Too many" }) : json(200, { data: { ok: 1 } }))) as typeof fetch;
  assert.deepEqual(await run("query { ok }"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a rate-limited MUTATION is also retried (429 means it never ran)", async () => {
  globalThis.fetch = (async () => (++calls === 1 ? json(429, { message: "Too many" }) : json(200, { data: { done: true } }))) as typeof fetch;
  assert.deepEqual(await run("mutation { done }"), { done: true });
  assert.equal(calls, 2);
});

test("persistent 429 gives a clear error after exactly two attempts", async () => {
  globalThis.fetch = (async () => (calls++, json(429, { message: "Too many" }))) as typeof fetch;
  await assert.rejects(run("query { ok }"), /Rate limited by the Trainzilla API \(HTTP 429\)/);
  assert.equal(calls, 2);
});

test("a hung query times out, is retried once, then succeeds", async () => {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => (++calls === 1 ? hang(url, init) : Promise.resolve(json(200, { data: { ok: 1 } })))) as typeof fetch;
  assert.deepEqual(await run("query { ok }"), { ok: 1 });
  assert.equal(calls, 2);
});

test("a query that keeps hanging fails with a timeout message", async () => {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => (calls++, hang(url, init))) as typeof fetch;
  await assert.rejects(run("query { ok }"), /did not respond within/);
  assert.equal(calls, 2);
});

test("a hung MUTATION is NOT retried and warns it may have been saved", async () => {
  globalThis.fetch = ((url: unknown, init?: RequestInit) => (calls++, hang(url, init))) as typeof fetch;
  await assert.rejects(run("mutation { done }"), /may or may not have been saved/);
  assert.equal(calls, 1);
});

test("a 503 on a MUTATION is not retried; on a query it is", async () => {
  globalThis.fetch = (async () => (calls++, json(503, { message: "down" }))) as typeof fetch;
  await assert.rejects(run("mutation { done }"), /HTTP 503/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(run("query { ok }"), /HTTP 503/);
  assert.equal(calls, 2);
});

test("GraphQL errors are returned as before without any retry", async () => {
  globalThis.fetch = (async () => (calls++, json(200, { errors: [{ message: "Access denied" }] }))) as typeof fetch;
  await assert.rejects(run("query { ok }"), /Access denied/);
  assert.equal(calls, 1);
});

test("each tool call logs name, duration, GraphQL attempts and retries (never arguments)", async () => {
  globalThis.fetch = (async () => (++calls === 1 ? json(429, { message: "Too many" }) : json(200, { data: { ok: 1 } }))) as typeof fetch;
  const lines: string[] = [];
  const realErr = console.error;
  console.error = (m: unknown) => void lines.push(String(m));
  try {
    const handler = instrumentHandler("list_things", async (_args: { secret: string }) => ({
      content: [{ type: "text" as const, text: "{}" }],
      data: await run("query { ok }"),
    }));
    await handler({ secret: "client-private-note" });
  } finally {
    console.error = realErr;
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.mcp, "tool_call");
  assert.equal(entry.tool, "list_things");
  assert.equal(entry.ok, true);
  assert.equal(entry.gql, 2);
  assert.equal(entry.retries, 1);
  assert.ok(!lines[0].includes("client-private-note"));
});

test("a failed tool result is logged with its error", async () => {
  const lines: string[] = [];
  const realErr = console.error;
  console.error = (m: unknown) => void lines.push(String(m));
  try {
    await instrumentHandler("bad_tool", async () => ({ isError: true, content: [{ type: "text", text: "Error: nope" }] }))();
  } finally {
    console.error = realErr;
  }
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.ok, false);
  assert.match(entry.error, /nope/);
});
