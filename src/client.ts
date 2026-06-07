import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

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

async function rawPost<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string
): Promise<{ status: number; body: GraphQLResponse<T> }> {
  const res = await fetch(config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      role: "trainer",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  let body: GraphQLResponse<T>;
  try {
    body = (await res.json()) as GraphQLResponse<T>;
  } catch {
    body = { errors: [{ message: `Non-JSON response (HTTP ${res.status})` }] };
  }
  return { status: res.status, body };
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
