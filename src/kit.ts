import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
export function writeTool(server: McpServer, spec: ToolSpec & { destructive?: boolean }): void {
  const doc = buildDoc("mutation", spec);
  REGISTERED_DOCS.push({ tool: spec.name, doc });
  const desc = `${spec.desc} (confirm-gated: previews until confirm: true)`;
  server.tool(
    spec.name,
    desc,
    { ...(spec.shape ?? {}), ...confirmField },
    spec.destructive ? DESTRUCTIVE : {},
    async (input: Record<string, unknown>) => {
      const { confirm, ...rest } = input;
      if (!confirm) return preview(spec.name, rest);
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
