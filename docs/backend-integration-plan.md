# Hosting the Trainzilla MCP inside `tzilla-be` — integration plan

Status: DRAFT for review. No code changed yet.
Goal: serve the MCP at `https://api.tzilla.live/mcp`, authenticated by the trainer
API keys from PR #45, as part of the existing backend deploy (no separate service).

---

## 1. Architecture decision

Two integration modes were considered:

| | A. GraphQL pass-through | B. In-process resolvers |
|---|---|---|
| MCP tools call… | backend's own `/graphql` over localhost HTTP | resolvers/persistence directly |
| Code change to tools | **none** (keep GraphQL client) | rewrite all 23 tools off GraphQL |
| Auth | forward `tz_` key to `/graphql` (PR #45 middleware authenticates it) | authenticate `tz_` key in `/mcp`, build `AppContext` directly |
| Overhead | one localhost HTTP hop per GraphQL op | none |
| Risk | low | medium (touches every tool) |

**Decision: ship Option A first.** It reuses the entire existing auth + resolver stack
with zero tool rewrites. Revisit B only if the localhost self-call shows up in latency
profiling. The plan below is written for A, with a note on the B upgrade path.

---

## 2. Packaging decision

`tzilla-mcp` stays its own package (keeps the local stdio/dev story intact). To consume it
from the backend:

- Refactor `tzilla-mcp/src/http.ts` to **export a factory** instead of calling `app.listen()`:
  - `export function mcpRouter(): express.Router` — a router with the `POST /` handler
    (current `/mcp` body), `GET /` + `DELETE /` → 405, and an optional `GET /health`.
  - Keep the standalone `app.listen()` bootstrap behind an `import.meta.url === entry` guard
    (same pattern as `index.ts`) so `npm run http` still works for local dev.
- **DECISION: pinned git dependency** (clean single source of truth, no registry):
  ```json
  // tzilla-be/package.json
  "tzilla-mcp": "github:Trainzilla/tzilla-mcp#<commit-sha>"
  ```
  - Requires a `"prepare": "npm run build"` script in `tzilla-mcp` so `dist/` is built on
    install (dist is gitignored). npm runs `prepare` for git deps with devDeps available.
  - **Pin to a SHA**, never a branch, so backend deploys can't pull unreviewed MCP changes.
  - **Prerequisite:** deploy/CI must auth to the private repo (almost certainly already true —
    the pipeline clones `tzilla-be` from the same org).
  - **Fallback** (only if private-repo auth in deploy is blocked): vendor `dist/` into
    `tzilla-be` with a `scripts/sync-mcp.sh` to prevent drift.
- `tzilla-mcp` must build to ESM/CJS compatible with `tzilla-be`'s `tsc` + `node dist`. Verify
  module format alignment (backend is CJS-ish via ts-node/tsc; tzilla-mcp is `"type": "module"`).
  **Action item:** confirm interop or expose a CJS build target for the router entry.

---

## 3. Routes

Mount in `tzilla-be/src/setup/server.ts` `createApp()`, alongside `/graphql`:

```
POST   /mcp        → MCP JSON-RPC (stateless StreamableHTTP handler)
GET    /mcp        → 405 (stateless: no SSE stream)
DELETE /mcp        → 405
GET    /mcp/health → { ok: true, server: "tzilla-coach" }   (optional; /health already exists)
```

- Mount **after** the security-headers + CORS middleware (inherited from `createBaseApp`),
  **before** the generic error handler.
- Add `includeMcp = true` to the `createApp({ includeApi, includeGraphQl })` options so it can
  be toggled per entrypoint (web vs worker) like the others.

```ts
// server.ts (sketch)
if (includeMcp) {
  app.use('/mcp',
    express.json({ limit: '4mb' }),       // own parser/limit (see §5)
    createMcpRateLimiters(),               // own limiter (see §4)
    mcpRouter(),
  );
}
```

---

## 4. Rate limiting

Do **not** reuse `createGraphQlRateLimiters()` — a single MCP call (e.g. "build a plan")
fans out into many GraphQL ops, so per-request limits differ.

- New `createMcpRateLimiters()` using the same `express-rate-limit` lib.
- **Key by API key**, not IP (multiple coaches may share an egress IP): `keyGenerator` →
  hash of the `tz_` key (reuse `ApiKeyDb.hashKey`), fall back to IP if absent.
- Suggested defaults (configurable via `config.app.*`, mirror the GraphQL knobs):
  - window: 60s
  - limit: ~120 MCP requests / key / min (each may trigger several GraphQL ops downstream;
    the GraphQL limiter still applies to those, so this is a coarse outer bound).
- Unauthenticated (`tz_`-less) requests are already rejected 401 by the handler before any
  work — keep a tight IP-based limiter in front to blunt abuse.

---

## 5. Body parsing

`createBaseApp()` mounts `express.raw` for the two Razorpay webhook paths **before** the global
`express.json()`. `/mcp` is unaffected, but to be explicit and control the limit independently,
attach a **route-local** `express.json({ limit: '4mb' })` on the `/mcp` mount (matches the
current standalone server). The global `express.json()` running first is harmless (idempotent),
but the route-local limit documents intent and isolates the 4 MB cap to MCP.

---

## 6. Auth (reuses PR #45)

The MCP handler requires `Authorization: Bearer tz_...` (or `x-api-key`). In Option A it simply
**forwards that header to `/graphql`**, where the existing `auth.ts` path authenticates it:

```
readApiKey(req) → ApiKeyDb.findActiveByHash(hashKey(raw)) → userId
                → resolveAuthenticatedRole(...) → ctx.role=trainer
                → ApiKeyDb.touchLastUsed(...)
```

- Set the MCP's `TZ_API_URL` to the backend's **own** GraphQL URL. In-process this should be
  `http://127.0.0.1:${config.app.port}/graphql` (loopback, no extra TLS hop, no public round-trip).
- The MCP client (`client.ts`) already puts the caller's key into `Authorization` via
  `runWithToken()` — so the key flows: coach → `/mcp` → `/graphql` → DB. The MCP server never
  stores tokens. Multi-coach safe by construction.
- **Reject non-`tz_` credentials** at `/mcp` (the handler already checks `key.startsWith('tz_')`)
  so raw JWTs can't be smuggled through the MCP surface.

**Option B upgrade (later):** replace the localhost GraphQL hop by calling
`readApiKey`/`findActiveByHash`/`resolveAuthenticatedRole` directly in `/mcp` to build an
`AppContext`, then invoke resolver/persistence functions. Removes the self-call entirely.

---

## 7. CORS

- `/mcp` is normally called by server-side MCP clients (Claude Desktop, hosted agents) — **not**
  browsers — so it usually needs no CORS at all.
- If a browser-based MCP client must connect, add its origin to `isOriginAllowed`. Do **not**
  blanket-allow `*` on `/mcp` since it carries the `tz_` key.

---

## 8. Config / env (add to `config.app`)

| Key | Purpose | Default |
|---|---|---|
| `MCP_ENABLED` | feature-flag the `/mcp` mount | `false` until rollout |
| `MCP_RATE_LIMIT_WINDOW_MS` | limiter window | `60000` |
| `MCP_RATE_LIMIT_MAX` | requests/key/window | `120` |
| `MCP_SELF_GRAPHQL_URL` | loopback GraphQL URL the MCP forwards to | `http://127.0.0.1:${port}/graphql` |

All read through the existing `assertions.getStringPropOrThrowErr` pattern in `config/index.ts`.

---

## 9. Observability

- The existing `createPerformanceRequestLogger()` covers `/mcp` automatically (it's mounted on
  the app). Add a `route: 'mcp'` tag + the (non-secret) key prefix for correlation.
- Log per-request: tool name(s) invoked, key prefix, duration, GraphQL ops fired, outcome.
- **Never log the raw `tz_` key** — log `prefix` (`tz_` + 6 chars) only.
- Add an audit trail for **write** tools (createWorkoutPlan/createDietPlan/createHabit/…):
  `{ keyPrefix, userId, tool, entityId, ts }`. (Feeds Phase-4 audit-log requirement.)

---

## 10. Deploy

- Ships with the normal `tzilla-be` build/deploy — no new infra, no new TLS cert.
- Gate behind `MCP_ENABLED=false` in prod until verified on staging
  (`wiring-all-prs-features`), then flip on.
- Health: reuse `/health`; optionally add `/mcp/health` for MCP-specific liveness.

---

## 11. Testing

- **Unit:** `mcpRouter()` returns 401 without `tz_`, 405 on GET/DELETE, 200 JSON-RPC on a
  minimal `initialize`/`tools/list` POST.
- **Integration:** with a seeded ApiKey in the test DB, POST a `tools/call whoami` and assert it
  round-trips through `/graphql` and returns the trainer. (Note: backend tests need the CI env;
  this rides the same harness.)
- **Smoke (staging):** point `scripts/smoke-http.mjs` at `https://staging/mcp` with a real key.
- **Lint:** keep new files in the `lint:ci` clean set (the repo's pre-existing `tests/` `any`
  debt is a separate blocker, tracked independently).

---

## 12. Rollout sequence

1. Merge + deploy **PR #45** (API keys) — prerequisite, already open.
2. Refactor `http.ts` → `mcpRouter()` in `tzilla-mcp`; publish/vendor (§2).
3. `feat/mcp-mount` on `tzilla-be`: add `createMcpRateLimiters`, config keys, `/mcp` mount behind
   `MCP_ENABLED`. PR → `wiring-all-prs-features`.
4. Deploy staging, smoke-test with a real `tz_` key.
5. Flip `MCP_ENABLED=true` on prod after promotion.
6. Web app: show the connect URL (`https://api.tzilla.live/mcp`) + "paste your key" on the API
   Keys card (extends PR #40).
7. (Later) OAuth authorize endpoint on the same backend → true one-click.

---

## 13. Open questions / risks

- **ESM↔CJS interop** — RESOLVED. `tzilla-mcp` is ESM-only (the MCP SDK is `type: module`) and
  `tzilla-be` is CJS on Node 20 (no `require(esm)`). Bridge: load via **dynamic `import()`** inside
  the already-async `createApp()` — the same pattern the backend already uses for `./routes` and
  `@socket.io/redis-adapter`: `const { mcpRouter } = await import('tzilla-mcp/http')`. No CJS build
  target or module-format change needed. Requires an `exports` map in `tzilla-mcp/package.json`
  exposing `./http`.
- **Self-call latency** (Option A) — acceptable for MVP; measure, upgrade to B if needed.
- **Streaming** — staying stateless (no SSE) avoids sticky-session/load-balancer work; confirm
  no MCP feature we need requires server-initiated streams.
- **Scope on keys** — DECISION: keys are **read-write** (no scopes) for now. A `tz_` key can call
  write tools; safety relies on the confirm-gated write tools. Revisit scopes later if needed.
