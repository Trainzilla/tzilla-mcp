import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrackingTools } from "./tracking.js";
import { registerCommunityGymTools } from "./community-gym.js";
import { registerCatalogProfileWorkflowTools } from "./catalog-profile-workflows.js";
import { registerBusinessTools } from "./business.js";
import { registerAiCheckinsInboxTools } from "./ai-checkins-inbox.js";

/** Tool groups added after the original index.ts — one module per domain. */
export function registerExtraTools(server: McpServer): void {
  registerTrackingTools(server);
  registerAiCheckinsInboxTools(server);
  registerBusinessTools(server);
  registerCatalogProfileWorkflowTools(server);
  registerCommunityGymTools(server);
}
