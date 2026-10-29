// Validates every GraphQL document the declarative tools send against a schema file.
//   SCHEMA=/path/to/schema.graphql GRAPHQL_PKG=/path/to/node_modules/graphql node scripts/validate-docs.mjs
// (build first: npm run build). Exits 1 on any invalid document.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const schemaPath = process.env.SCHEMA;
const pkg = process.env.GRAPHQL_PKG;
if (!schemaPath || !pkg) {
  console.error("Set SCHEMA and GRAPHQL_PKG");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { buildSchema, parse, validate } = require(pkg);
const schema = buildSchema(readFileSync(schemaPath, "utf8"));

process.env.TZ_ACCESS_TOKEN ||= "x";
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { registerAll } = await import(pathToFileURL(path.resolve("dist/index.js")).href);
const { REGISTERED_DOCS } = await import(pathToFileURL(path.resolve("dist/kit.js")).href);

registerAll(new McpServer({ name: "validate", version: "0" }));
let bad = 0;
for (const { tool, doc } of REGISTERED_DOCS) {
  try {
    const errors = validate(schema, parse(doc));
    if (errors.length) {
      bad++;
      console.error(`✗ ${tool}: ${errors.map((e) => e.message).join(" | ")}`);
    }
  } catch (e) {
    bad++;
    console.error(`✗ ${tool}: ${e.message}`);
  }
}
console.log(`${REGISTERED_DOCS.length} documents checked, ${bad} invalid`);
process.exit(bad ? 1 : 0);
