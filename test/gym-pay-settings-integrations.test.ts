import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGymPaySettingsIntegrationTools } from "../src/tools/gym-pay-settings-integrations.js";

const READS = [
  "get_gym_direct_payment", "get_gym_stripe_connection", "get_gym_razorpay_connection",
  "get_my_notification_settings", "get_client_notification_settings",
  "get_calendly_status", "list_calendly_unmatched_bookings",
  "list_webhooks", "list_webhook_deliveries",
  "get_client_group_limits", "get_client_access", "list_client_onboarding_optional_steps",
];
const WRITES = [
  "update_gym_direct_payment", "connect_gym_stripe", "disconnect_gym_stripe", "connect_gym_razorpay", "disconnect_gym_razorpay",
  "update_my_notification_settings", "update_client_notification_settings", "update_my_away_message", "update_my_name",
  "dismiss_calendly_unmatched_booking", "start_calendly_connect", "disconnect_calendly",
  "create_webhook", "set_webhook_active", "send_test_webhook", "delete_webhook",
  "add_client_onboarding_step",
];
const DESTRUCTIVE = ["disconnect_gym_stripe", "disconnect_gym_razorpay", "disconnect_calendly", "delete_webhook"];

type Reg = Record<string, { inputSchema?: { shape?: Record<string, unknown> }; annotations?: Record<string, unknown> }>;

test("all tools register; writes confirm-gated; disconnects/deletes destructive", () => {
  const server = new McpServer({ name: "t", version: "0" });
  registerGymPaySettingsIntegrationTools(server);
  const tools = (server as unknown as { _registeredTools: Reg })._registeredTools;
  assert.equal(Object.keys(tools).length, READS.length + WRITES.length);
  for (const n of READS) assert.equal(tools[n]?.annotations?.readOnlyHint, true, `${n} read-only`);
  for (const n of WRITES) {
    const shape = tools[n].inputSchema?.shape ?? (tools[n].inputSchema as unknown as { _def?: { shape?: () => Record<string, unknown> } })?._def?.shape?.();
    assert.ok(shape && "confirm" in shape, `${n} must expose confirm`);
  }
  for (const n of DESTRUCTIVE) assert.equal(tools[n].annotations?.destructiveHint, true, `${n} destructive`);
});

test("secrets are hidden in previews and bad input is rejected", async () => {
  process.env.TZ_ACCESS_TOKEN = "x";
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = new McpServer({ name: "t", version: "0" });
  registerGymPaySettingsIntegrationTools(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

  const stripe = await client.callTool({ name: "connect_gym_stripe", arguments: { organizationId: "o1", apiKey: "rk_test_abcdef123" } });
  assert.doesNotMatch(text(stripe), /rk_test_abcdef123/);
  assert.match(text(stripe), /hidden/);
  const rzp = await client.callTool({ name: "connect_gym_razorpay", arguments: { organizationId: "o1", keyId: "rzp_test_1", keySecret: "supersecret99" } });
  assert.doesNotMatch(text(rzp), /supersecret99/);

  const sk = await client.callTool({ name: "connect_gym_stripe", arguments: { organizationId: "o1", apiKey: "sk_live_x" } });
  assert.equal(sk.isError, true);
  const http = await client.callTool({ name: "create_webhook", arguments: { url: "http://example.com/h", events: ["CLIENT_JOINED"] } });
  assert.equal(http.isError, true);
  const noEvents = await client.callTool({ name: "create_webhook", arguments: { url: "https://hooks.zapier.com/x", events: [] } });
  assert.equal(noEvents.isError, true);
  const quiet = await client.callTool({ name: "update_my_notification_settings", arguments: { input: { quietHours: { start: "10pm", end: "07:00" } } } });
  assert.equal(quiet.isError, true);
  const ok = await client.callTool({ name: "create_webhook", arguments: { url: "https://hooks.zapier.com/x", events: ["PAYMENT_CONFIRMED"] } });
  assert.match(text(ok), /"status": "preview"/);
});
