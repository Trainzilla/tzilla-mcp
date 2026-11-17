import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const organizationId = id.describe("Gym/organization _id (from list_my_organizations)");

const ORG_PAYMENT = "usingOwnerDetails settings { enabled url upiId provider instructions cardCheckout razorpayCheckout }";
const STRIPE = "connected keyLast4 livemode accountCountry connectedAt";
const RAZORPAY = "connected keyLast4 livemode connectedAt";
const NOTIFY = "emailReminders pushReminders timezone quietHours { start end }";
const WEBHOOK = "id url events isActive secretLast4 disabledReason lastDeliveryAt lastStatus createdAt";
const DELIVERY = "id event status attempts lastStatus lastError createdAt deliveredAt";
const STEP = "key type title description status autoProvision linkedEntityId autoProvisionError completedAt";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const notificationInput = z.object({
  quietHours: z.object({ start: hhmm, end: hhmm }).optional().describe("No reminders between start and end, in the user's timezone"),
  emailReminders: z.boolean().optional(),
  pushReminders: z.boolean().optional(),
});
const webhookEvents = z.array(z.enum(["CLIENT_JOINED", "PAYMENT_CONFIRMED", "CHECKIN_SUBMITTED", "PERSONAL_RECORD_HIT"])).min(1);

export function registerGymPaySettingsIntegrationTools(server: McpServer): void {
  /* ── Gym payments (owner/admin) — the coach-level versions are *_my_* tools ── */
  readTool(server, {
    name: "get_gym_direct_payment",
    desc: "How clients pay the gym directly (UPI / payment link / instructions), and whether it falls back to the owner's own details.",
    field: "organizationPayment",
    args: "organizationId: ID!",
    select: ORG_PAYMENT,
    shape: { organizationId },
  });
  writeTool(server, {
    name: "update_gym_direct_payment",
    desc: "Set the gym's direct-pay details shown at checkout: a payment link (url) and/or UPI id, plus instructions. enabled: false turns direct pay off.",
    field: "updateOrganizationDirectPayment",
    args: "organizationId: ID!, input: DirectPaymentInput!",
    select: ORG_PAYMENT,
    shape: {
      organizationId,
      input: z.object({ enabled: z.boolean(), url: z.string().optional(), upiId: z.string().optional(), instructions: z.string().max(500).optional() }),
    },
  });
  readTool(server, {
    name: "get_gym_stripe_connection",
    desc: "Whether the gym's own Stripe account is connected for card checkout (key last 4, live/test, country).",
    field: "organizationStripeConnection",
    args: "organizationId: ID!",
    select: STRIPE,
    shape: { organizationId },
  });
  writeTool(server, {
    name: "connect_gym_stripe",
    desc: "Connect the gym's Stripe account with a restricted key (rk_live_… / rk_test_…) that has Checkout Sessions, Webhook Endpoints and Customers write and Subscriptions read. The key is stored server-side and never echoed back.",
    field: "connectOrganizationStripe",
    args: "organizationId: ID!, apiKey: String!",
    select: STRIPE,
    shape: { organizationId, apiKey: z.string().regex(/^rk_(live|test)_/, "Use a restricted key (rk_live_… or rk_test_…), not a secret key") },
    secrets: ["apiKey"],
  });
  writeTool(server, {
    name: "disconnect_gym_stripe",
    desc: "Remove the gym's Stripe webhook and stored key; gym card checkout turns off.",
    field: "disconnectOrganizationStripe",
    args: "organizationId: ID!",
    select: "connected",
    shape: { organizationId },
    destructive: true,
  });
  readTool(server, {
    name: "get_gym_razorpay_connection",
    desc: "Whether the gym's own Razorpay account (India) is connected.",
    field: "organizationRazorpayConnection",
    args: "organizationId: ID!",
    select: RAZORPAY,
    shape: { organizationId },
  });
  writeTool(server, {
    name: "connect_gym_razorpay",
    desc: "Connect the gym's Razorpay account with its Key Id and Key Secret so members pay by UPI/card and plans activate themselves. The secret is stored server-side and never echoed back.",
    field: "connectOrganizationRazorpay",
    args: "organizationId: ID!, keyId: String!, keySecret: String!",
    select: RAZORPAY,
    shape: { organizationId, keyId: z.string().min(6), keySecret: z.string().min(6) },
    secrets: ["keySecret"],
  });
  writeTool(server, {
    name: "disconnect_gym_razorpay",
    desc: "Delete the gym's stored Razorpay keys and turn gym Razorpay checkout off.",
    field: "disconnectOrganizationRazorpay",
    args: "organizationId: ID!",
    select: "connected",
    shape: { organizationId },
    destructive: true,
  });

  /* ── Settings ── */
  readTool(server, {
    name: "get_my_notification_settings",
    desc: "The coach's own reminder settings: email/push on or off and quiet hours.",
    field: "myNotificationSettings",
    select: NOTIFY,
  });
  writeTool(server, {
    name: "update_my_notification_settings",
    desc: "Change the coach's own reminder settings. Only the fields given change.",
    field: "updateMyNotificationSettings",
    args: "input: NotificationSettingsInput!",
    select: NOTIFY,
    shape: { input: notificationInput },
  });
  readTool(server, {
    name: "get_client_notification_settings",
    desc: "A client's reminder settings (email/push and quiet hours) — e.g. to see why they aren't getting check-in reminders.",
    field: "clientNotificationSettings",
    args: "clientId: ID!",
    select: NOTIFY,
    shape: { clientId },
  });
  writeTool(server, {
    name: "update_client_notification_settings",
    desc: "Change a client's reminder settings on their behalf (e.g. quiet hours for a night-shift client). Only the fields given change.",
    field: "updateClientNotificationSettings",
    args: "clientId: ID!, input: NotificationSettingsInput!",
    select: NOTIFY,
    shape: { clientId, input: notificationInput },
  });
  writeTool(server, {
    name: "update_my_away_message",
    desc: "Set the auto-reply clients see when they message the coach (e.g. on holiday). Omit text or send an empty string to turn it off.",
    field: "updateMyAwayMessage",
    args: "text: String",
    shape: { text: z.string().max(1000).optional() },
  });
  writeTool(server, {
    name: "update_my_name",
    desc: "Change the coach's display name (shown to clients, on invoices and the public profile).",
    field: "updateMyName",
    args: "name: String!",
    select: "_id name",
    shape: { name: z.string().trim().min(1).max(100) },
  });

  /* ── Calendly ── */
  readTool(server, {
    name: "get_calendly_status",
    desc: "Calendly integration state: connected account, whether it needs reconnecting, webhook health, and how many bookings didn't match a client.",
    field: "calendlyStatus",
    select: "configured connected accountEmail needsReconnect webhooksActive webhookProblem unmatchedCount",
  });
  readTool(server, {
    name: "list_calendly_unmatched_bookings",
    desc: "Calendly bookings whose invitee email didn't match any client, so no session was created. Invite or add the person, or dismiss the booking.",
    field: "calendlyUnmatchedBookings",
    select: "id inviteeEmail inviteeName scheduledStart scheduledEnd meetingLink",
  });
  writeTool(server, {
    name: "dismiss_calendly_unmatched_booking",
    desc: "Hide an unmatched Calendly booking from the list (the booking itself stays in Calendly).",
    field: "dismissCalendlyUnmatchedBooking",
    args: "id: ID!",
    shape: { id },
  });
  writeTool(server, {
    name: "start_calendly_connect",
    desc: "Get the Calendly sign-in link. Give the URL to the coach to open; bookings then become Trainzilla sessions automatically.",
    field: "startCalendlyConnect",
    args: "returnTo: String",
    shape: { returnTo: z.string().optional().describe("App path to land on afterwards") },
  });
  writeTool(server, {
    name: "disconnect_calendly",
    desc: "Disconnect Calendly; new bookings stop syncing (existing sessions stay).",
    field: "disconnectCalendly",
    destructive: true,
  });

  /* ── Webhooks (Zapier/Make/own server) ── */
  readTool(server, {
    name: "list_webhooks",
    desc: "The coach's outbound webhooks: URL, subscribed events, on/off, last delivery status.",
    field: "myWebhooks",
    select: WEBHOOK,
  });
  readTool(server, {
    name: "list_webhook_deliveries",
    desc: "Recent delivery attempts for one webhook (status, attempts, last error) — for debugging a Zap that stopped firing.",
    field: "webhookDeliveries",
    args: "webhookId: ID!",
    select: DELIVERY,
    shape: { webhookId: id },
  });
  writeTool(server, {
    name: "create_webhook",
    desc: "Send Trainzilla events to an https URL (Zapier/Make catch hook or the coach's server). Returns the signing secret ONCE — tell the coach to store it. Events: CLIENT_JOINED, PAYMENT_CONFIRMED, CHECKIN_SUBMITTED, PERSONAL_RECORD_HIT.",
    field: "createWebhook",
    args: "url: String!, events: [WebhookEventName!]!",
    select: `secret webhook { ${WEBHOOK} }`,
    shape: { url: z.string().url().max(500).startsWith("https://", "Must be an https URL"), events: webhookEvents },
  });
  writeTool(server, {
    name: "set_webhook_active",
    desc: "Pause or resume a webhook.",
    field: "setWebhookActive",
    args: "id: ID!, isActive: Boolean!",
    select: WEBHOOK,
    shape: { id, isActive: z.boolean() },
  });
  writeTool(server, {
    name: "send_test_webhook",
    desc: "Send a sample event to the webhook now and return the delivery result.",
    field: "sendTestWebhook",
    args: "id: ID!",
    select: DELIVERY,
    shape: { id },
  });
  writeTool(server, {
    name: "delete_webhook",
    desc: "Delete a webhook; events stop being sent to that URL.",
    field: "deleteWebhook",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });

  /* ── Client access & onboarding ── */
  readTool(server, {
    name: "get_client_group_limits",
    desc: "Whether the coach can use client groups on their tier, and the max groups / members per group.",
    field: "clientGroupAccess",
    select: "allowed tier maxGroups maxMembersPerGroup",
  });
  readTool(server, {
    name: "get_client_access",
    desc: "The coach's role over one client: viewer type, gym role, whether they're the primary coach, and which gym capabilities they hold. Use when an action on a gym client is refused.",
    field: "clientScreenAccess",
    args: "clientId: ID!",
    select: "viewer organizationId role isPrimaryCoach capabilities { key label scope }",
    shape: { clientId },
  });
  readTool(server, {
    name: "list_client_onboarding_optional_steps",
    desc: "Onboarding steps not yet on a client's checklist that can be added (their keys feed add_client_onboarding_step).",
    field: "clientOnboardingDeferredSteps",
    args: "clientId: ID!",
    select: STEP,
    shape: { clientId },
  });
  writeTool(server, {
    name: "add_client_onboarding_step",
    desc: "Add an optional step (by key from list_client_onboarding_optional_steps) to a client's onboarding checklist.",
    field: "addClientOnboardingStep",
    args: "clientId: ID!, stepKey: String!",
    select: `_id status completedStepCount totalStepCount steps { key title status }`,
    shape: { clientId, stepKey: z.string().min(1) },
  });
}
