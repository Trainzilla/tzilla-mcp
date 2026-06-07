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

export const config = {
  apiUrl: process.env.TZ_API_URL?.trim() || "https://api.tzilla.live/graphql",
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
