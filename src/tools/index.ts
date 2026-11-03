import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTrackingTools } from "./tracking.js";
import { registerCommunityGymTools } from "./community-gym.js";
import { registerCatalogProfileWorkflowTools } from "./catalog-profile-workflows.js";
import { registerSecretsUploadTools } from "./secrets-uploads.js";
import { registerBusinessTools } from "./business.js";
import { registerAiCheckinsInboxTools } from "./ai-checkins-inbox.js";
import { registerLibraryUnitTools } from "./library-units.js";
import { registerGroupTools } from "./groups.js";
import { registerCoachNoteTools } from "./coach-notes.js";

/** Tool groups added after the original index.ts — one module per domain. */
export function registerExtraTools(server: McpServer): void {
  registerTrackingTools(server);
  registerAiCheckinsInboxTools(server);
  registerBusinessTools(server);
  registerSecretsUploadTools(server);
  registerCatalogProfileWorkflowTools(server);
  registerCommunityGymTools(server);
  registerLibraryUnitTools(server);
  registerGroupTools(server);
  registerCoachNoteTools(server);
}
