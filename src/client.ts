import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";
import { noteGqlAttempt } from "./observability.js";

/**
 * Per-request auth token (used by the HTTP transport, where each MCP request
 * carries its own Trainzilla API key). When set, it's used as-is (no refresh —
 * API keys don't expire). When unset (stdio mode), the env JWT + refresh is used.
 */
const authStore = new AsyncLocalStorage<string>();
export function runWithToken<T>(token: string, fn: () => T): T {
  return authStore.run(token, fn);
}

/**
 * Tiny GraphQL client for the Trainzilla API.
 * - Sends `Authorization: Bearer <accessToken>` + `role: trainer` (some
 *   trainer-scoped queries require the role header).
 * - On an auth error, refreshes the access token via `refreshAccessToken`
 *   (rotating refresh token) and retries the request once.
 */

let accessToken = config.accessToken;
let refreshToken = config.refreshToken;

interface GraphQLError {
  message: string;
  extensions?: { code?: string };
}
interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

const REFRESH_MUTATION = /* GraphQL */ `
  mutation RefreshAccessToken($refreshToken: String!) {
    refreshAccessToken(refreshToken: $refreshToken) {
      accessToken
      refreshToken
    }
  }
`;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 400;
const MAX_RETRY_AFTER_MS = 3_000;

/** Read per call (not at import) so hosts and tests can tune them without a restart. */
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function isMutation(query: string): boolean {
  return /^(\s|#[^\n]*\n)*mutation\b/i.test(query);
}

function retryDelayMs(res?: Response): number {
  const header = Number(res?.headers.get("retry-after"));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : envMs("TZ_MCP_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS);
  return Math.min(base, MAX_RETRY_AFTER_MS) + (base > 0 ? Math.floor(Math.random() * 150) : 0);
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * POST one GraphQL document with a timeout and at most ONE retry.
 * - 429 is retried for everything: the request was rejected before it ran, so it is safe even for a mutation.
 * - Timeouts, network errors and 502/503/504 are retried for queries only. A mutation may already have been
 *   applied, so it fails with an explicit "check before retrying" message instead of risking a double write.
 */
async function rawPost<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string
): Promise<{ status: number; body: GraphQLResponse<T> }> {
  const mutation = isMutation(query);
  const timeoutMs = mutation
    ? envMs("TZ_MCP_MUTATION_TIMEOUT_MS", DEFAULT_MUTATION_TIMEOUT_MS)
    : envMs("TZ_MCP_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          role: "trainer",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      noteGqlAttempt({ retry: attempt > 0 });
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (!mutation && attempt === 0) {
        await sleep(retryDelayMs());
        continue;
      }
      const why = timedOut
        ? `The Trainzilla API did not respond within ${Math.round(timeoutMs / 1000)}s`
        : `Could not reach the Trainzilla API (${e instanceof Error ? e.message : String(e)})`;
      throw new Error(
        mutation ? `${why}. The change may or may not have been saved - check before retrying.` : `${why}. Try again shortly.`
      );
    }

    noteGqlAttempt({ retry: attempt > 0, status: res.status });
    const retryable = res.status === 429 || (!mutation && [502, 503, 504].includes(res.status));
    if (retryable && attempt === 0) {
      await sleep(retryDelayMs(res));
      continue;
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await res.json()) as GraphQLResponse<T>;
    } catch {
      body = { errors: [{ message: `Non-JSON response (HTTP ${res.status})` }] };
    }
    return { status: res.status, body };
  }
}

function isAuthError(status: number, body: GraphQLResponse<unknown>): boolean {
  if (status === 401) return true;
  return (body.errors ?? []).some((e) => {
    const code = e.extensions?.code ?? "";
    return (
      code === "UNAUTHENTICATED" ||
      code === "UNAUTHORIZED" ||
      /unauth|expired|jwt|token/i.test(e.message)
    );
  });
}

async function refresh(): Promise<boolean> {
  if (!refreshToken) return false;
  const { body } = await rawPost<{
    refreshAccessToken: { accessToken: string; refreshToken: string };
  }>(REFRESH_MUTATION, { refreshToken }, "");
  const payload = body.data?.refreshAccessToken;
  if (!payload?.accessToken) return false;
  accessToken = payload.accessToken;
  refreshToken = payload.refreshToken || refreshToken;
  return true;
}

function finish<T>(status: number, body: GraphQLResponse<T>): T {
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  if (body.data === undefined) {
    if (status === 429) throw new Error("Rate limited by the Trainzilla API (HTTP 429). Wait a few seconds and retry.");
    throw new Error(`Empty GraphQL response (HTTP ${status})`);
  }
  return body.data;
}

export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  // HTTP mode: a per-request API key is in scope — use it directly, no refresh.
  const requestToken = authStore.getStore();
  if (requestToken) {
    const { status, body } = await rawPost<T>(query, variables, requestToken);
    return finish(status, body);
  }

  // stdio/env mode: JWT access token with refresh-on-401.
  let { status, body } = await rawPost<T>(query, variables, accessToken);
  if (isAuthError(status, body) && (await refresh())) {
    ({ status, body } = await rawPost<T>(query, variables, accessToken));
  }
  return finish(status, body);
}

/** GET a REST endpoint on the same API host (e.g. "/api/chat/chats"), with the same auth + refresh as gql(). */
export async function restGet<T>(path: string): Promise<T> {
  const url = new URL(path, config.apiUrl).toString();
  const call = async (token: string) =>
    fetch(url, { headers: { Accept: "application/json", role: "trainer", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const requestToken = authStore.getStore();
  let res = await call(requestToken ?? accessToken);
  if (!requestToken && (res.status === 401 || res.status === 403) && (await refresh())) res = await call(accessToken);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** True when the call is serving an HTTP-transport request (per-request API key) rather than a local stdio session. */
export function isHttpRequest(): boolean {
  return authStore.getStore() !== undefined;
}

/** Bearer token + headers for authenticated REST calls. */
export function authHeaders(): Record<string, string> {
  const token = authStore.getStore() ?? accessToken;
  return { role: "trainer", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** Resolve a REST path against the API host. */
export function restUrl(path: string): string {
  return new URL(path, config.apiUrl).toString();
}
