import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader (no dependency). Only fills vars that aren't already set. */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env file — rely on process.env (e.g. from the MCP host config) */
  }
}

loadDotEnv();

function firstDefinedEnv(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeEnvironment(raw?: string): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();

  if (["prod", "production", "live"].includes(value)) return "production";
  if (["stage", "staging", "qa", "beta"].includes(value)) return "staging";
  if (["dev", "development", "local"].includes(value)) return "development";
  if (value === "test") return "test";

  return value;
}

function resolveDefaultApiUrl(): string {
  const explicitApiUrl = process.env.TZ_API_URL?.trim();
  if (explicitApiUrl) return explicitApiUrl;

  const environment = normalizeEnvironment(
    firstDefinedEnv([
      "TZ_ENVIRONMENT",
      "TZ_APP_ENV",
      "TRAINZILLA_ENV",
      "APP_ENV",
      "TZ_API_ENV",
      "NODE_ENV",
    ])
  );

  if (environment === "staging") {
    return "https://qa-be2.tzilla.live/graphql";
  }

  return "https://api.tzilla.live/graphql";
}

export const config = {
  apiUrl: resolveDefaultApiUrl(),
  accessToken: process.env.TZ_ACCESS_TOKEN?.trim() || "",
  refreshToken: process.env.TZ_REFRESH_TOKEN?.trim() || "",
};

export function assertConfigured(): void {
  if (!config.accessToken && !config.refreshToken) {
    throw new Error(
      "Missing auth: set TZ_ACCESS_TOKEN (and TZ_REFRESH_TOKEN) in .env or the MCP host config."
    );
  }
}
