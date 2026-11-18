import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tool annotations for directory listings (Claude Connectors Directory, ChatGPT apps): every tool needs a title and
 * either readOnlyHint or an explicit destructiveHint, and openWorldHint says the tool only touches the coach's own
 * Trainzilla account. Tools that already pass hints keep them; this fills in what is missing from the tool's name.
 */

/** Verbs that remove, revoke, cancel or irreversibly replace something. Matched at the start of the tool name. */
const DESTRUCTIVE_PREFIXES = [
  "delete_",
  "remove_",
  "cancel_",
  "revoke_",
  "disconnect_",
  "undo_",
  "close_",
  "reject_",
  "clear_",
  "dismiss_",
  "archive_",
  "leave_",
  "transfer_",
  "swap_",
  "reassign_",
  "move_",
  "change_organization_subscription_tier",
];

/** Read-only verbs, used only when a tool carries no hints at all (the declarative helpers already set them). */
const READ_ONLY_PREFIXES = ["get_", "list_", "search_", "browse_", "calc_", "lookup_", "find_", "recent_"];

export type Annotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export function humanizeToolName(name: string): string {
  if (name === "whoami") return "Who am I";
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isDestructiveName(name: string): boolean {
  return DESTRUCTIVE_PREFIXES.some((p) => name.startsWith(p));
}

export function inferAnnotations(name: string, given?: Annotations): Annotations {
  const out: Annotations = { ...(given ?? {}) };
  out.title = out.title ?? humanizeToolName(name);
  out.openWorldHint = out.openWorldHint ?? false;
  const hasHint = out.readOnlyHint !== undefined || out.destructiveHint !== undefined;
  if (!hasHint) {
    out.readOnlyHint = READ_ONLY_PREFIXES.some((p) => name.startsWith(p)) || name === "whoami";
  }
  if (out.readOnlyHint === true) {
    delete out.destructiveHint; // the spec ignores it for read-only tools
    return out;
  }
  out.readOnlyHint = false;
  out.destructiveHint = out.destructiveHint === true || isDestructiveName(name);
  return out;
}

/**
 * The same zod object used for two parameters of one tool (e.g. `startDate: day, endDate: day`) makes the JSON-schema
 * generator emit a `$ref` for the second one, which has no `type`; directories flag that ("Add a type to this
 * parameter"). Give every repeated instance its own copy.
 */
const CHILD_KEYS = ["innerType", "type", "schema", "in", "out", "left", "right"] as const;

/** Copy a zod schema (and the schemas it wraps) so no two parameters share a definition object. */
function cloneSchema(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== "object" || depth > 8) return v;
  const ctor = (v as { constructor: new (def: unknown) => unknown }).constructor;
  const def = (v as { _def?: Record<string, unknown> })._def;
  if (!def || typeof def !== "object") return v;
  const copy: Record<string, unknown> = { ...def };
  for (const key of CHILD_KEYS) {
    const child = copy[key];
    if (child && typeof child === "object" && (child as { _def?: unknown })._def) copy[key] = cloneSchema(child, depth + 1);
  }
  if (Array.isArray(copy.options)) copy.options = copy.options.map((o) => cloneSchema(o, depth + 1));
  return new ctor(copy);
}

/**
 * The same zod object used for two parameters of one tool (e.g. `startDate: day, endDate: day`, or `isoDate.optional()`
 * twice) makes the JSON-schema generator emit a `$ref` for the second one, which has no `type`; directories flag that
 * ("Add a type to this parameter"). Every parameter gets its own copy of its schema.
 */
export function dedupeShape(shape: unknown): unknown {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return shape;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape as Record<string, unknown>)) out[key] = cloneSchema(value);
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Rewrite the arguments of `server.tool(...)` so the annotations object is complete, whichever overload was used:
 * (name, desc, shape, annotations, cb) | (name, desc, shape, cb) | (name, desc, annotations, cb) | (name, desc, cb).
 */
export function withAnnotations(args: unknown[]): unknown[] {
  const name = String(args[0]);
  const cb = args[args.length - 1];
  if (typeof cb !== "function") return args;
  const middle = args.slice(1, -1);
  let desc: unknown;
  let shape: unknown;
  let ann: Annotations | undefined;
  if (typeof middle[0] === "string") desc = middle.shift();
  // After the description: [shape, annotations] | [shape] | [annotations] | []
  if (middle.length === 2) {
    shape = middle[0];
    ann = middle[1] as Annotations;
  } else if (middle.length === 1 && isPlainObject(middle[0])) {
    const o = middle[0];
    const looksLikeAnnotations = Object.keys(o).length > 0 && Object.keys(o).every((k) => /Hint$|^title$/.test(k));
    if (looksLikeAnnotations) ann = o as Annotations;
    else shape = o;
  }
  const merged = inferAnnotations(name, ann);
  return [name, ...(desc !== undefined ? [desc] : []), dedupeShape(shape ?? {}), merged, cb];
}

/** Patch `server.tool` so every tool registered afterwards carries complete annotations. Call before registering. */
export function annotateTools(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => original(...withAnnotations(args));
}
