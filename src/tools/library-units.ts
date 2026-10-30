import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);

const LIBRARY_ITEM = `id category title description kind url fileName mimeType createdAt updatedAt
  audience { all clientIds planIds }`;

const libraryInput = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  category: z.string().max(60).optional().describe("Free-text group such as Snack ideas or Travel; defaults to General"),
  link: z.string().url().optional().describe("A web page or Google Doc link (for a Google Doc set sharing to 'Anyone with the link can view'). Send exactly one of link or fileKey"),
  fileKey: z.string().optional().describe("S3 key of an uploaded PDF or image (from upload_file)"),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  audience: z
    .object({
      all: z.boolean().optional().describe("true = every client of the coach"),
      clientIds: z.array(id).optional().describe("Client User _ids (from list_clients)"),
      planIds: z.array(id).optional().describe("Everyone currently on these plans (from list_my_plans)"),
    })
    .describe("Who can see it: all: true, or specific clientIds and/or planIds"),
});

export function registerLibraryUnitTools(server: McpServer): void {
  /* ── Coach document library ── */
  readTool(server, {
    name: "list_library_items",
    desc: "The coach's document library: guides and documents (links, Google Docs, files) grouped by category, with who each is shared with.",
    field: "myLibraryItems",
    select: LIBRARY_ITEM,
  });
  writeTool(server, {
    name: "create_library_item",
    desc: "Add a document to the coach's library and choose who can see it. Clients find it in the client app at Me → Library. Use a link (web page / Google Doc) or a fileKey from upload_file.",
    field: "createLibraryItem",
    args: "input: LibraryItemInput!",
    select: LIBRARY_ITEM,
    shape: { input: libraryInput },
  });
  writeTool(server, {
    name: "update_library_item",
    desc: "Edit a library document (title, category, link, audience). Replaces the definition: fetch it with list_library_items and change only what's needed. A file document keeps its file when no fileKey is sent.",
    field: "updateLibraryItem",
    args: "id: ID!, input: LibraryItemInput!",
    select: LIBRARY_ITEM,
    shape: { id, input: libraryInput },
  });
  writeTool(server, {
    name: "delete_library_item",
    desc: "Remove a document from the coach's library; clients no longer see it.",
    field: "deleteLibraryItem",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });

  /* ── Default units for the coach's clients ── */
  readTool(server, {
    name: "get_client_unit_default",
    desc: "The unit system new clients start in for this coach: \"metric\", \"imperial\", or null (follow each client's phone region).",
    field: "myClientUnitDefault",
  });
  writeTool(server, {
    name: "set_client_unit_default",
    desc: "Set the unit system new clients (and clients added without the app) start in: \"metric\" (kg, cm), \"imperial\" (lbs, in) or null to follow each phone's region. Does not change units a client already chose.",
    field: "setClientUnitDefault",
    args: "units: String",
    shape: { units: z.enum(["metric", "imperial"]).nullable() },
  });
}
