import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const NOTES = "clientId notes updatedAt";

export function registerCoachNoteTools(server: McpServer): void {
  readTool(server, {
    name: "get_coach_client_notes",
    desc: "The coach's PRIVATE notes on one client (free text). Only this coach can ever see them: never the client, a gym's other coaches or admins. Returns an empty string when none are written. Pass the client's user _id.",
    field: "coachClientNotes",
    args: "clientId: ID!",
    select: NOTES,
    shape: { clientId: z.string().min(1) },
  });
  writeTool(server, {
    name: "set_coach_client_notes",
    desc: "Replace the coach's private notes on a client. This overwrites the whole note: call get_coach_client_notes first and send the full intended text (append to it to add a line). An empty string clears it. Never shown to the client.",
    field: "setCoachClientNotes",
    args: "clientId: ID!, notes: String!",
    select: NOTES,
    shape: { clientId: z.string().min(1), notes: z.string().max(20000) },
  });
}
