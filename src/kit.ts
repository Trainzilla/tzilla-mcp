import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { gql } from "./client.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
export async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export const confirmField = {
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true to actually execute. If false/omitted, returns a preview only."),
};

export function preview(action: string, details: unknown): ToolResult {
  return ok({ status: "preview", action, details, note: "Re-run the tool with confirm: true to execute." });
}

export const READ_ONLY = { readOnlyHint: true } as const;
export const DESTRUCTIVE = { destructiveHint: true } as const;
export const WRITE = { readOnlyHint: false } as const;

/** Every GraphQL document the declarative helpers send — lets scripts/validate-docs.mjs check them against the schema. */
export const REGISTERED_DOCS: { tool: string; doc: string }[] = [];

type Shape = Record<string, z.ZodTypeAny>;

interface ToolSpec {
  name: string;
  desc: string;
  /** Root field name on Query/Mutation. */
  field: string;
  /** GraphQL argument signature, e.g. "clientId: ID!, date: String!". Tool args with the same names become the variables. */
  args?: string;
  /** Selection set for object-returning fields; omit for scalars. */
  select?: string;
  /** Zod shape for the tool; keys must match the GraphQL argument names. */
  shape?: Shape;
  /** Full document override for multi-field queries; `field` is then only a label. */
  doc?: string;
  /** Extra variables computed per call (e.g. the coach's own trainerId). */
  resolve?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function parseArgs(sig: string | undefined): { name: string; type: string }[] {
  if (!sig?.trim()) return [];
  return sig
    .split(/,\s*(?=\w+\s*:)/)
    .map((part) => {
      const m = part.trim().match(/^(\w+)\s*:\s*(.+)$/);
      if (!m) throw new Error(`Bad args signature: ${sig}`);
      return { name: m[1], type: m[2].trim() };
    });
}

export function buildDoc(kind: "query" | "mutation", spec: Pick<ToolSpec, "field" | "args" | "select">): string {
  const args = parseArgs(spec.args);
  const decl = args.length ? `(${args.map((a) => `$${a.name}: ${a.type.replace(/\s*=.*$/, "")}`).join(", ")})` : "";
  const call = args.length ? `(${args.map((a) => `${a.name}: $${a.name}`).join(", ")})` : "";
  const sel = spec.select ? ` { ${spec.select} }` : "";
  return `${kind} Tool${decl} { ${spec.field}${call}${sel} }`;
}

function pickVars(spec: ToolSpec, input: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const a of parseArgs(spec.args)) if (input[a.name] !== undefined) vars[a.name] = input[a.name];
  return vars;
}

const TRAINER = async () => ({ trainerId: await trainerId() });
export { TRAINER };

/** A read-only tool backed by one GraphQL query field. */
export function readTool(server: McpServer, spec: ToolSpec): void {
  const doc = spec.doc ?? buildDoc("query", spec);
  REGISTERED_DOCS.push({ tool: spec.name, doc });
  server.tool(spec.name, spec.desc, spec.shape ?? {}, READ_ONLY, async (input: Record<string, unknown>) =>
    guard(async () => gql(doc, { ...pickVars(spec, input), ...(spec.resolve ? await spec.resolve(input) : {}) }))
  );
}

/** A confirm-gated write tool backed by one GraphQL mutation field. */
export function writeTool(server: McpServer, spec: ToolSpec & { destructive?: boolean; secrets?: string[] }): void {
  const doc = buildDoc("mutation", spec);
  REGISTERED_DOCS.push({ tool: spec.name, doc });
  const desc = `${spec.desc} (confirm-gated: previews until confirm: true)`;
  server.tool(
    spec.name,
    desc,
    { ...(spec.shape ?? {}), ...confirmField },
    spec.destructive ? DESTRUCTIVE : WRITE, // never `{}` — the SDK would read it as the input shape
    async (input: Record<string, unknown>) => {
      const { confirm, ...rest } = input;
      if (!confirm) {
        const shown = { ...rest };
        for (const k of spec.secrets ?? []) if (k in shown) shown[k] = "••••(hidden)";
        return preview(spec.name, shown);
      }
      return guard(() => gql(doc, pickVars(spec, rest)));
    }
  );
}

/** Pagination arg pair most list queries share. */
export const pageShape = {
  pageNumber: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
};

export async function trainerId(): Promise<string> {
  const data = await gql<{ trainer?: { userId?: string } }>(`query { trainer { userId } }`);
  const id = data.trainer?.userId;
  if (!id) throw new Error("Could not resolve trainer id for the authenticated user.");
  return id;
}

/* ───────────────────────── Client groups: fan-out tools ───────────────────────── */

/** What every assign / message / check-in / session mutation returns, member by member. */
export const GROUP_OUTCOME = `assignmentId preview createdCount skippedCount failedCount
  rows { clientId name itemId status reason }`;

export const groupOptionsShape = {
  groupIds: z.array(z.string().min(1)).min(1).max(10).describe("Group ids from list_client_groups"),
  excludeClientIds: z.array(z.string().min(1)).optional().describe("Members to leave out this time (client User _ids)"),
  allowDuplicates: z.boolean().optional().describe("Also give it to a member who already has the same thing over the same dates (default: skip them)"),
};

/**
 * Run (or preview) one group fan-out. Without confirm the SERVER previews it, so the coach sees the real list of who
 * would get it and who would be skipped (and why); nothing is written. With confirm it runs, under an idempotency key
 * derived from the arguments and the current 10-minute window, so asking twice in a row cannot assign twice.
 */
/** The mutation document for a group fan-out tool; registered so scripts/validate-docs.mjs checks it against the schema. */
export function groupDoc(tool: string, field: string, argsSig: string): string {
  const call = argsSig
    .split(",")
    .map((a) => a.trim().split(":")[0].replace("$", ""))
    .map((n) => `${n}: $${n}`)
    .join(", ");
  const doc = `mutation Tool(${argsSig}, $options: GroupAssignOptions!) { ${field}(${call}, options: $options) { ${GROUP_OUTCOME} } }`;
  if (!REGISTERED_DOCS.some((d) => d.tool === tool)) REGISTERED_DOCS.push({ tool, doc });
  return doc;
}

export async function runGroupAssign(
  tool: string,
  field: string,
  argsSig: string,
  vars: Record<string, unknown>,
  options: { groupIds: string[]; excludeClientIds?: string[]; allowDuplicates?: boolean },
  confirm: boolean,
): Promise<ToolResult> {
  const doc = groupDoc(tool, field, argsSig);
  return guard(async () => {
    const key = confirm
      ? createHash("sha256").update(JSON.stringify([tool, vars, options, Math.floor(Date.now() / 600_000)])).digest("hex").slice(0, 40)
      : undefined;
    const data = await gql<Record<string, unknown>>(doc, {
      ...vars,
      options: { ...options, preview: !confirm, ...(key ? { requestKey: key } : {}) },
    });
    const outcome = data[field];
    return confirm
      ? outcome
      : { status: "preview", action: tool, outcome, note: "Nothing was written. Re-run with confirm: true to do it for these clients." };
  });
}

/** Register a confirm-gated group fan-out tool whose arguments are passed straight through. */
export function groupAssignTool(
  server: McpServer,
  spec: { name: string; desc: string; field: string; sig: string; shape: Shape; destructive?: boolean },
): void {
  groupDoc(spec.name, spec.field, spec.sig);
  server.tool(
    spec.name,
    `${spec.desc} (confirm-gated: without confirm it previews who would get it, writing nothing)`,
    { ...spec.shape, ...groupOptionsShape, ...confirmField },
    WRITE,
    async (input: Record<string, unknown>) => {
      const { confirm, groupIds, excludeClientIds, allowDuplicates, ...vars } = input as Record<string, unknown> & {
        confirm: boolean; groupIds: string[]; excludeClientIds?: string[]; allowDuplicates?: boolean;
      };
      return runGroupAssign(spec.name, spec.field, spec.sig, vars, { groupIds, excludeClientIds, allowDuplicates }, Boolean(confirm));
    }
  );
}
