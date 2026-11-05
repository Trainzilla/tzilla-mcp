import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gql } from "../client.js";
import { confirmField, guard, preview, REGISTERED_DOCS, WRITE } from "../kit.js";

/**
 * Switching from another coaching platform: one batch invite that carries each client's name, phone and a private
 * note. The note is kept on the invitation and lands in the coach's client notes (see set_coach_client_notes) when the
 * client connects. The `switch-to-trainzilla` skill drives this tool and the history-import tools.
 */

const MAX_RECIPIENTS = 200;

/** Same text as skills/switch-to-trainzilla/SKILL.md (below the front matter); test/switch.test.ts keeps them identical. */
export const SWITCH_INSTRUCTIONS = "You are moving a coach's business into Trainzilla using the Trainzilla (tzilla-coach) tools. This works from whatever the coach has, whichever platform it came from. Never assume a platform's column names or export layout: read what the coach gives you and map it yourself.\n\n# Ground rules\n- Work from what the coach gives you: files, pasted text, screenshots, photos, or a page they have open themselves. Never ask for, store or type in their password for the old platform. If they have no file at all, use \"When there is no export\" below.\n- Every write tool is confirm-gated. Run it without confirm first, show the coach the preview in plain words, and only send confirm: true after their explicit yes. Invites send real emails to real people.\n- Do not invent data. If a value is missing or unreadable, leave it out and list it back to the coach.\n- Be honest about limits (see \"What cannot move\").\n\n# Steps\n1. Intake. Ask what they have: a client list or export (CSV, xlsx, pasted table, screenshot), program or meal-plan PDFs/text, notes, past check-ins or measurements. Anything is fine; partial is fine. If the old platform offers no export, or the coach doesn't know, go to \"When there is no export\" first, then continue with step 2. Confirm they are on Coach Pro (bulk invite needs it); if the invite fails for that reason, say so and stop.\n2. Parse the clients. Pasted or helper-captured tables use one tab per column, and a blank cell means that client has no value there, so never shift later values left to fill it. If a row has fewer cells than the header, say so and ask instead of guessing which column is missing. Find email (required), name (join first and last), phone (keep the country code if present). Build ONE private note per client from anything useful: goals, injuries, medical notes, tags, programme name, start date, status. Label each part (\"Goal: ...\", \"Injury: ...\"). Drop archived or inactive clients only if the coach says to. Lowercase and de-duplicate emails. Clients with no email cannot be invited here: list them for the coach (they can share an invite link from the app).\n3. Dry run. Show a compact table (name, email, phone, note preview) and the counts: total, with phone, with notes, skipped and why. Ask whether to start with 2 or 3 clients as a test. Call bulk_invite_clients without confirm, ask for the yes, then send in batches of at most 200.\n4. Report every row's outcome (sent, already invited, duplicate, invalid email, failed) from the result. Do not retry blindly; re-running a list is safe because duplicates and pending invites are skipped.\n5. Plans. From PDFs or text, build workout plans with create_workout_plan_template and meal plans with create_diet_plan_template (a client must exist before create_workout_plan or create_diet_plan can assign one). Keep the coach's exercise wording and rep ranges (\"8-10\"). Preview each, confirm, create. Assign after the client connects.\n6. History, once clients have accepted (check list_clients; invites stay pending until the client taps the link). Offer, per client and only for data the coach actually gave you: add_client_progress_history (back-dated weight, measurements, photos; also works before the client finishes onboarding), import_checkin_history (past check-ins and answers). Use exact dates, state the units, and never fill gaps. Notes you attached to the invite are saved to the coach's private client notes automatically when the client connects; use get_coach_client_notes before set_coach_client_notes, because that tool overwrites.\n7. Wrap up: what moved, what is pending (invites not yet accepted), what could not move, and the next step (ask clients to open the invite email and install the app).\n\n# When there is no export\nMany platforms have no CSV, Excel or PDF export, or hide it. Never tell the coach they are stuck. Offer these in order of effort and let them pick; all of them end in the same client table for step 2.\n1. Copy and paste (best). Ask them to open the client list in the old app or website, select the whole list (or each page of it) and paste it into the chat. On Chrome, Edge or Brave, point them to the free \"Trainzilla: copy client list\" helper (Chrome Web Store, or the install page https://app.trainzilla.in/copy-client-list/): they open the list, click the helper on each page, then Copy all and paste. It captures the table as clean tab-separated text, recovers emails hidden behind \"Message\" or mail-icon links, and merges pages without duplicates. A pasted table is messy but readable: find the name, email and phone columns yourself, and ask about anything unclear. For long lists, ask for it in chunks of 50-100 rows. The same works for a programme: paste the text of each workout day, or each meal plan.\n2. Screenshots or photos. If the chat accepts images, ask for screenshots of the client list, one per screen, and transcribe them into a table. Say clearly that you read it from a picture, and show the table so the coach can fix typos in emails before anything is sent. If the chat does not accept images, fall back to option 1 or 4.\n3. Another place the same people already live. Clients are often also in: the coach's payment tool (Stripe, PayPal, Razorpay, bank or UPI statement exports, which usually do export CSV), Google Contacts or phone contacts (vCard or CSV), a mailing list, WhatsApp group members, Instagram or Facebook DMs, a booking tool (Calendly, Cal.com), or an invoice folder. Ask where else the clients appear and use that list. Match people across lists by email, then phone, and tell the coach about people who appear in only one.\n4. Type or dictate it. For up to about 30 clients, ask the coach to list them (name, email, phone, one line about each) in plain sentences or a quick voice-to-text dump. Format it for them.\n5. Read the client list from the coach's own browser (only in a Claude that has browser tools next to the Trainzilla tools, such as Claude in Chrome or the Claude desktop browser; the Trainzilla in-app AI Assistant has no browser, so there use options 1-4). Do this only if the coach asks for it, and keep it small:\n   - The coach opens the old platform and signs in themselves. You never see, ask for or type a password, 2FA code or CAPTCHA. If a sign-in, 2FA or CAPTCHA page appears at any point, stop and hand control back.\n   - Read only the clients list: use the page text or accessibility tree rather than screenshots when you can, page through it with the platform's own Next or Load more control, and write each row into your client table as you go. Do not open individual client profiles unless the coach asks for specific details (notes, goals) for named clients, and then one profile at a time.\n   - Read-only: never click anything that edits, deletes, messages or exports, never change settings, never leave the clients area, never run scripts against their site, and never bulk-crawl. Stop if the page starts to fail or rate-limit.\n   - Tell the coach what you are about to read before you start, and that the old platform's terms are theirs to check. Prefer options 1-4 whenever they will do.\n   - Then show the table you collected and continue with step 2; nothing is sent to Trainzilla until the coach confirms the preview.\nWhichever route is used:\n- Email is the only required field. If the source has names but no emails (common with photos of a roster, or WhatsApp groups), do not guess or construct emails. List those people for the coach: they can share an invite link from the app, or you can ask them for the addresses.\n- Double-check everything transcribed from images or voice: show the full table and ask the coach to confirm before bulk_invite_clients.\n- Programmes and meal plans: if they only exist inside the old app, paste or photograph a day at a time, or have the coach recreate the few they reuse most as templates. Do not promise a complete transfer of plans.\n- History (old workouts, weights, photos) usually cannot be extracted without an export. Offer it only for what the coach can actually paste or type, such as a few key weights or start dates per client.\n- Never scrape, bulk-download or script the old platform. Small, coach-supervised steps only.\n\n# What cannot move\n- You cannot pull anything out of the old platform yourself. Whatever the coach cannot export, paste, photograph or type, stays there.\n- Old workout logs and progress photos only come across if the coach has them as files or text. Otherwise clients start fresh; suggest keeping the old account read-only for a month.\n- Payments and subscriptions with the old platform are not touched. The coach cancels or keeps them themselves.\n- Clients must accept the invite before they exist in Trainzilla; connected-only data waits for that.";

const recipient = z.object({
  email: z.string().min(3).describe("Client's email"),
  name: z.string().max(100).optional(),
  phone: z.string().max(40).optional().describe("With country code if the source has it"),
  notes: z
    .string()
    .max(20000)
    .optional()
    .describe("Private coach note for this client (goals, injuries, tags, anything useful from the old platform). Never shown to the client."),
});

const DOC = `mutation Tool($input: SendBulkInvitationsInput!) { sendBulkInvitations(input: $input) {
  totalSubmitted sentCount skippedCount failedCount results { email name outcome message } } }`;

export function registerSwitchTools(server: McpServer): void {
  server.prompt(
    "switch_to_trainzilla",
    "Move a coach's clients, notes, plans and history from any other platform or spreadsheet into Trainzilla, step by step with previews.",
    { source: z.string().optional().describe("Where they are coming from, e.g. Trainerize, Everfit, a spreadsheet") },
    ({ source }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `${source ? `I am switching from ${source}. ` : ""}Help me move my clients to Trainzilla.\n\n${SWITCH_INSTRUCTIONS}` },
        },
      ],
    }),
  );
  REGISTERED_DOCS.push({ tool: "bulk_invite_clients", doc: DOC });
  server.tool(
    "bulk_invite_clients",
    "Invite many clients at once (up to 200), e.g. when a coach moves over from another platform (confirm-gated: previews until confirm: true). " +
      "Each gets an email invite; name, phone and a private note per client are kept and applied when they connect. " +
      "Coach Pro only. Duplicates within the list and people with a pending invite are skipped, and every row reports its own outcome, so re-running a list is safe. " +
      "History (check-ins, weight, photos) can be loaded after clients connect: see import_checkin_history and add_client_progress_history.",
    {
      recipients: z.array(recipient).min(1).max(MAX_RECIPIENTS),
      groupId: z.string().optional().describe("Optional client group to put everyone in when they connect"),
      expiresInHours: z.number().int().positive().optional(),
      ...confirmField,
    },
    WRITE,
    async ({ confirm, recipients, groupId, expiresInHours }) => {
      if (!confirm) {
        return preview("bulk_invite_clients", {
          count: recipients.length,
          withPhone: recipients.filter((r) => r.phone).length,
          withNotes: recipients.filter((r) => r.notes).length,
          recipients: recipients.map((r) => ({ ...r, notes: r.notes ? `${r.notes.slice(0, 80)}${r.notes.length > 80 ? "…" : ""}` : undefined })),
        });
      }
      return guard(() => gql(DOC, { input: { recipients, ...(groupId ? { groupId } : {}), ...(expiresInHours ? { expiresInHours } : {}) } }));
    },
  );
}
