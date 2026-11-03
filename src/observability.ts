import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Per-tool-call diagnostics. Every tool call logs one JSON line to stderr (stdout is the MCP channel in
 * stdio mode; in the hosted server stderr lands in the process manager logs) with the tool name, duration,
 * outcome and how many GraphQL requests / retries it took. Without this a "the MCP timed out" report from a
 * coach or a gateway (Composio etc.) can't be matched to anything on our side.
 *
 * Set TZ_MCP_TOOL_LOG=off to silence it. Arguments and results are never logged (they hold client data).
 */

interface CallStats {
  tool: string;
  gqlRequests: number;
  retries: number;
  lastStatus?: number;
}

const callStore = new AsyncLocalStorage<CallStats>();

/** Called by the GraphQL client for every HTTP attempt so the tool-call log line can report it. */
export function noteGqlAttempt(info: { retry: boolean; status?: number }): void {
  const stats = callStore.getStore();
  if (!stats) return;
  stats.gqlRequests += 1;
  if (info.retry) stats.retries += 1;
  if (info.status !== undefined) stats.lastStatus = info.status;
}

function loggingEnabled(): boolean {
  return (process.env.TZ_MCP_TOOL_LOG ?? "").trim().toLowerCase() !== "off";
}

function resultError(result: unknown): string | undefined {
  const r = result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  if (!r?.isError) return undefined;
  return String(r.content?.[0]?.text ?? "error").slice(0, 200);
}

export function logToolCall(line: Record<string, unknown>): void {
  if (!loggingEnabled()) return;
  console.error(JSON.stringify({ mcp: "tool_call", ...line }));
}

/** Wrap a tool handler so each call is timed and logged. Exported for tests. */
export function instrumentHandler<A extends unknown[], R>(
  tool: string,
  handler: (...args: A) => Promise<R> | R,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const stats: CallStats = { tool, gqlRequests: 0, retries: 0 };
    const started = Date.now();
    try {
      const result = await callStore.run(stats, () => handler(...args));
      const error = resultError(result);
      logToolCall({
        tool,
        ms: Date.now() - started,
        ok: !error,
        gql: stats.gqlRequests,
        retries: stats.retries,
        ...(stats.lastStatus !== undefined && stats.lastStatus >= 400 ? { httpStatus: stats.lastStatus } : {}),
        ...(error ? { error } : {}),
      });
      return result;
    } catch (e) {
      logToolCall({
        tool,
        ms: Date.now() - started,
        ok: false,
        gql: stats.gqlRequests,
        retries: stats.retries,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
      throw e;
    }
  };
}

/**
 * Patch `server.tool` so every handler registered afterwards is instrumented. Call before registering tools.
 * The MCP SDK's `tool()` takes the handler as its last argument whatever the overload.
 */
export function instrumentTools(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = String(args[0]);
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      args[last] = instrumentHandler(name, args[last] as (...a: unknown[]) => unknown);
    }
    return original(...args);
  };
}
