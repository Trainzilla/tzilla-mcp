#!/usr/bin/env node
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./index.js";
import { runWithToken } from "./client.js";

/**
 * Remote MCP transport (Streamable HTTP), stateless, bound to localhost.
 *
 * Auth is pass-through: each request must present the coach's Trainzilla API key
 * (`Authorization: Bearer tz_...` or `x-api-key`). The server never holds tokens —
 * it forwards the caller's key to the GraphQL API, so the backend enforces scope.
 * This makes it multi-coach safe.
 */

const PORT = Number(process.env.MCP_HTTP_PORT || 8787);
const HOST = process.env.MCP_HTTP_HOST || "127.0.0.1"; // localhost only by default

function readApiKey(req: Request): string | undefined {
  const headerKey = req.header("x-api-key");
  if (headerKey?.trim()) return headerKey.trim();
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const v = auth.slice("Bearer ".length).trim();
    if (v) return v;
  }
  return undefined;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, server: "tzilla-coach" }));

app.post("/mcp", async (req: Request, res: Response) => {
  const key = readApiKey(req);
  if (!key || !key.startsWith("tz_")) {
    return rpcError(res, 401, -32001, "Missing/invalid Trainzilla API key. Send 'Authorization: Bearer tz_...'.");
  }

  // Stateless: a fresh server + transport per request.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await runWithToken(key, () => transport.handleRequest(req, res, req.body));
  } catch (e) {
    if (!res.headersSent) {
      rpcError(res, 500, -32603, e instanceof Error ? e.message : "Internal error");
    }
  }
});

// Stateless mode has no SSE stream / session teardown.
const notAllowed = (_req: Request, res: Response) =>
  rpcError(res, 405, -32000, "Method not allowed (stateless server).");
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, HOST, () => {
  console.error(`tzilla-coach MCP HTTP server on http://${HOST}:${PORT}/mcp`);
});
