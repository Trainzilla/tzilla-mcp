import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isHttpRequest, restGet } from "../client.js";
import { confirmField, fail, guard, preview, readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const orgId = id.describe("Gym id (from list_my_organizations)");
const s3Key = z.string().min(1).describe("Key returned by upload_file");

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic",
  ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".pdf": "application/pdf",
};

/** Presign → PUT. Returns the S3 key other tools take. */
async function uploadBytes(bytes: Buffer, contentType: string): Promise<{ key: string; bytes: number; contentType: string }> {
  const sign = await restGet<{ url: string; key: string; maxSize?: number }>(`/api/aws/presign?type=${encodeURIComponent(contentType)}`);
  if (sign.maxSize && bytes.length > sign.maxSize) {
    throw new Error(`File is ${bytes.length} bytes; the limit for ${contentType} is ${sign.maxSize}.`);
  }
  const res = await fetch(sign.url, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`);
  return { key: sign.key, bytes: bytes.length, contentType };
}

export function registerSecretsUploadTools(server: McpServer): void {
  /* ── Uploads: file → S3 key → the tool that needs it ── */
  server.tool(
    "upload_file",
    "Upload a photo, video or PDF to Trainzilla storage and get back its S3 `key`, which other tools take (health reports, PDF plan import, member photo, receipts, community media, branding logos). " +
      "Pass `filePath` (local stdio server only) or `base64` + `contentType`. Confirm-gated: reads/uploads only with confirm: true.",
    {
      filePath: z.string().optional().describe("Absolute path on the machine running this server (not available over HTTP)"),
      base64: z.string().optional().describe("File bytes, base64-encoded"),
      contentType: z.string().optional().describe("image/*, video/* or application/pdf; inferred from the file extension if omitted"),
      ...confirmField,
    },
    async ({ filePath, base64, contentType, confirm }) => {
      if (!filePath && !base64) return fail("Pass filePath or base64.");
      if (filePath && isHttpRequest()) return fail("filePath is only available on a local (stdio) server; pass base64 instead.");
      if (!confirm) return preview("upload_file", { filePath, base64: base64 ? `(${base64.length} base64 chars)` : undefined, contentType });
      return guard(async () => {
        let bytes: Buffer;
        let type = contentType;
        if (filePath) {
          const ext = path.extname(filePath).toLowerCase();
          type ??= TYPES[ext];
          if (!type || !TYPES[ext]) throw new Error(`Only ${Object.keys(TYPES).join(", ")} files can be uploaded.`);
          if ((await stat(filePath)).size > 200 * 1024 * 1024) throw new Error("File is over 200 MB.");
          bytes = await readFile(filePath);
        } else {
          if (!type) throw new Error("contentType is required with base64.");
          bytes = Buffer.from(base64!, "base64");
        }
        if (!/^(image\/|video\/|application\/pdf$)/.test(type)) throw new Error("contentType must be image/*, video/* or application/pdf.");
        return uploadBytes(bytes, type);
      });
    }
  );
  server.tool(
    "get_media_url",
    "A short-lived download URL for a stored file key (e.g. a receipt or report).",
    { key: z.string().min(1) },
    { readOnlyHint: true },
    async ({ key }) => guard(() => restGet(`/api/aws/media/${encodeURIComponent(key)}`))
  );

  writeTool(server, {
    name: "upload_client_health_report",
    desc: "Attach an uploaded scan/report (key from upload_file: InBody, DEXA, blood test, smart-scale photo or PDF) to a client; extraction runs in the background — check with list_client_health_reports.",
    field: "confirmHealthReportUpload",
    args: "clientId: ID!, s3Key: String!, originalFilename: String",
    select: "_id status originalFilename",
    shape: { clientId, s3Key, originalFilename: z.string().optional() },
  });
  writeTool(server, {
    name: "start_plan_import",
    desc: "Read an uploaded plan PDF (key from upload_file) into an editable draft for a client; poll get_plan_import until READY, then review and save_imported_plans.",
    field: "startPlanImport",
    args: "clientId: ID!, s3Key: String!, fileName: String",
    select: "_id status",
    shape: { clientId, s3Key, fileName: z.string().optional() },
  });
  writeTool(server, {
    name: "share_uploaded_pdf_plan",
    desc: "Assign an uploaded PDF (key from upload_file) as a client's workout or diet plan as-is — nothing to log.",
    field: "sharePdfPlan",
    args: "input: SharePdfPlanInput!",
    select: "kind planId",
    shape: {
      input: z.object({
        clientId,
        kind: z.enum(["WORKOUT", "DIET"]),
        s3Key,
        fileName: z.string().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "set_gym_member_photo",
    desc: "Set a gym member's photo (key from upload_file), or clear it by passing no photoKey.",
    field: "setOrganizationMemberPhoto",
    args: "organizationId: ID!, clientId: ID!, photoKey: String",
    shape: { organizationId: orgId, clientId, photoKey: s3Key.optional() },
  });
  writeTool(server, {
    name: "record_coach_desk_payment_with_proof",
    desc: "Solo coach: record a cash/UPI/bank payment from a client with an uploaded receipt (proofKey from upload_file) — active membership (no auto-renew), payment, proof and invoice.",
    field: "recordCoachDeskPayment",
    args: "clientId: ID!, input: RecordDeskMembershipInput!",
    select: "_id status currentPeriodEnd",
    shape: {
      clientId,
      input: z.object({
        planId: id,
        startDate: z.string(),
        endDate: z.string().optional(),
        amount: z.number().int().positive().optional().describe("Minor units; defaults to the plan price"),
        method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "DIRECT_LINK", "OTHER"]),
        reference: z.string().optional(),
        proofKey: s3Key.optional(),
        paidAt: z.string().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "create_community_post_with_media",
    desc: "Publish a community post with uploaded photos/videos (mediaKeys from upload_file). Visible to every member immediately — only after the coach approves.",
    field: "createCommunityPost",
    args: "input: CreateCommunityPostInput!",
    select: "_id text mediaUrls createdAt",
    shape: {
      input: z.object({
        scopeType: z.enum(["ORGANIZATION", "COACH"]),
        scopeId: id,
        text: z.string().min(1).max(2000),
        mediaKeys: z.array(s3Key).min(1).max(10),
      }),
    },
  });
  writeTool(server, {
    name: "update_my_branding_images",
    desc: "Set the coach's branding logo and/or square app icon from uploaded images (keys from upload_file).",
    field: "updateTrainerBranding",
    args: "input: UpdateTrainerBrandingInput!",
    select: "userId",
    shape: { input: z.object({ branding: z.object({ logoKey: s3Key.optional(), iconKey: s3Key.optional() }) }) },
  });

  /* ── API keys ── */
  readTool(server, {
    name: "list_api_keys",
    desc: "The coach's API keys (name, prefix, last used) — never the secret.",
    field: "apiKeys",
    select: "_id name prefix lastUsedAt createdAt",
  });
  writeTool(server, {
    name: "create_api_key",
    desc: "Create an API key for connecting another MCP client. The secret is returned ONCE in this response — tell the coach to store it now; it can't be shown again.",
    field: "createApiKey",
    args: "name: String!",
    select: "apiKey info { _id name prefix createdAt }",
    shape: { name: z.string().min(1).max(60) },
  });
  writeTool(server, {
    name: "revoke_api_key",
    desc: "Revoke an API key; anything using it stops working immediately.",
    field: "revokeApiKey",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });

  /* ── Payment provider connections (secret keys) ── */
  writeTool(server, {
    name: "connect_my_stripe",
    desc: "Connect the coach's own Stripe account with a restricted key (rk_live_… / rk_test_…) that has Checkout Sessions: write, Webhook Endpoints: write, Customers: write and Subscriptions: read. Clients can then pay by card and plans activate themselves. The key is stored server-side and never echoed back.",
    field: "connectMyStripe",
    args: "apiKey: String!",
    select: "connected keyLast4 livemode accountCountry connectedAt",
    shape: { apiKey: z.string().regex(/^rk_(live|test)_/, "Use a restricted key (rk_live_… or rk_test_…), not a secret key") },
    secrets: ["apiKey"],
  });
  writeTool(server, {
    name: "disconnect_my_stripe",
    desc: "Remove the webhook from the coach's Stripe account and delete the stored key; card checkout turns off.",
    field: "disconnectMyStripe",
    select: "connected",
    destructive: true,
  });
  writeTool(server, {
    name: "connect_my_razorpay",
    desc: "Connect the coach's own Razorpay account (India) with its Key Id and Key Secret. Clients can then pay by UPI or card and plans activate themselves. The secret is stored server-side and never echoed back.",
    field: "connectMyRazorpay",
    args: "keyId: String!, keySecret: String!",
    select: "connected keyLast4 livemode connectedAt",
    shape: { keyId: z.string().min(6), keySecret: z.string().min(6) },
    secrets: ["keySecret"],
  });
  writeTool(server, {
    name: "disconnect_my_razorpay",
    desc: "Delete the stored Razorpay keys and turn Razorpay checkout off.",
    field: "disconnectMyRazorpay",
    select: "connected",
    destructive: true,
  });

  /* ── Google Calendar ── */
  writeTool(server, {
    name: "start_google_calendar_connect",
    desc: "Get the Google sign-in URL that connects the coach's calendar for session sync. Give the URL to the coach to open in their browser and approve; then check get_google_calendar_status.",
    field: "startGoogleCalendarConnect",
    args: "returnTo: String",
    shape: { returnTo: z.string().optional().describe("Where to send the coach after approving (a Trainzilla app URL)") },
  });
}
