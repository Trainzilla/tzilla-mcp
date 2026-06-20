# tzilla-mcp (MVP, local only)

A local [MCP](https://modelcontextprotocol.io) server that lets an MCP client
(Claude Desktop, Claude Code, Cursor, …) act as a **Trainzilla coach**. It wraps
the existing GraphQL API at `api.tzilla.live` — no direct DB access — so all
auth and business rules stay enforced by the backend.

> Status: **Local MVP** — read tools, offline calculators, and **confirm-gated
> write tools**, plus a resource + a prompt. Not deployed anywhere. Runs entirely
> on your machine against your own coach login.

## What it can do today (23 tools, 1 resource, 1 prompt)

**Read (live data):**
- `whoami`, `list_clients`, `get_client_profile`
- `list_client_habits`, `get_habit_compliance`, `recent_habit_activity`, `master_habits`
- `list_workout_plans`, `list_diet_plans`
- `list_checkins`, `list_sessions`, `list_subscriptions`, `billing_summary`

**Calculators (offline, no network):**
- `calc_tdee` — BMR / TDEE / recommended calories
- `calc_macros` — macro split by strategy (Standard 40/30/30, Pro g/kg, Keto)
- `calc_1rm` — 1-rep-max (Epley) + %1RM weight suggestions

**Write (confirm-gated):** every write tool returns a **preview** unless called
with `confirm: true`, so nothing changes by accident:
- `create_habit`, `create_master_habit`, `assign_master_habit`
- `create_checkin` (with questions), `schedule_session`
- `create_workout_plan`, `create_diet_plan`

Still **not** exposed: deletes, payment execution/refunds, messaging, permission
changes — by design.

**Resource:** `tzilla://client/{clientId}/profile` — a client's profile as JSON.

**Prompt:** `weekly_client_review` — pulls profile/habits/compliance/sessions and
writes a read-only weekly review.

## Setup

```bash
npm install
npm run build
```

Create `.env` (see `.env.example`) with a coach's tokens. Easiest source — log in
to the coach web app, then in the browser console:

```js
localStorage.getItem("token")        // -> TZ_ACCESS_TOKEN
localStorage.getItem("refreshToken") // -> TZ_REFRESH_TOKEN
```

The server auto-refreshes the access token via `refreshAccessToken` when it expires.

## Run

**Local (stdio)** — for Claude Desktop etc.:
- Dev:  `npm run dev`
- Built: `npm start`
- Smoke: `node scripts/smoke.mjs`

**Remote (Streamable HTTP)** — localhost only, multi-coach:
- Dev:  `npm run http`  ·  Built: `npm run start:http`
- Listens on `http://127.0.0.1:8787/mcp` (set `MCP_HTTP_PORT` / `MCP_HTTP_HOST`).
- Smoke: `node scripts/smoke-http.mjs`

## Auth modes

- **stdio:** uses `TZ_ACCESS_TOKEN` (+ `TZ_REFRESH_TOKEN`) from env; auto-refreshes.
- Endpoint selection:
  - `TZ_API_URL` wins when set.
  - Otherwise `TZ_ENVIRONMENT=staging` uses `https://qa-be2.tzilla.live/graphql`.
  - All other cases default to `https://api.tzilla.live/graphql`.
- **HTTP:** **pass-through** — each request must send the coach's **API key**
  (`Authorization: Bearer tz_...` or `x-api-key`). The server never stores tokens;
  it forwards the caller's key to the GraphQL API, so the backend enforces scope
  (multi-coach safe). API keys are minted by the backend feature below.

### Backend: trainer API keys (built in `tzilla-be`, local — not deployed yet)
- `createApiKey(name)` → returns the plaintext `tz_…` key **once** + info
- `apiKeys` (list, no secret) · `revokeApiKey(id)`
- Auth middleware accepts `tz_` keys (header `x-api-key` or `Bearer`), resolves the
  owning coach, and stamps `lastUsedAt`. Only a SHA-256 hash is stored.

## Use from Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "tzilla-coach": {
      "command": "node",
      "args": ["C:/New folder/tzilla-mcp/dist/index.js"],
      "env": {
        "TZ_API_URL": "https://api.tzilla.live/graphql",
        "TZ_ACCESS_TOKEN": "<paste>",
        "TZ_REFRESH_TOKEN": "<paste>"
      }
    }
  }
}
```

Restart Claude Desktop, then try: *"Use tzilla-coach: who am I, and list my clients."*

## Roadmap

- [x] Write tools (habits, check-ins, sessions, plans) — confirm-gated
- [x] Resource (client profile) + prompt (weekly review)
- [x] Wider read coverage (plans, check-ins, sessions, billing)
- [x] Backend trainer API keys / PAT (built in `tzilla-be`, local — needs PR + deploy)
- [x] Remote Streamable-HTTP transport (localhost, API-key pass-through auth)
- [ ] Deploy the backend API-key feature; host the HTTP server (TLS) for real remote use
- [ ] Full MCP OAuth 2.1 (replace pass-through) for a public connector
- [ ] More resources (plans / check-in history) + prompts (e.g. "draft a plan")

## Layout

```
src/
  config.ts   # env + tiny .env loader
  client.ts   # GraphQL client: bearer auth + refresh-on-401 + role header
  calc.ts     # offline coach math (ported from HealthMath/WorkoutMath)
  index.ts    # MCP server + tool definitions (stdio)
scripts/
  smoke.mjs   # spawns the server and lists tools (handshake check)
```
