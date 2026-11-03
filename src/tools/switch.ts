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
export const SWITCH_INSTRUCTIONS = "You are moving a coach's business into Trainzilla using the Trainzilla (tzilla-coach) tools. This works from whatever the coach has, whichever platform it came from. Never assume a platform's column names or export layout: read what the coach gives you and map it yourself.\n\n# Ground rules\n- Work only from files, pasted text and screenshots the coach gives you. Never ask for, or use, their login for the old platform.\n- Every write tool is confirm-gated. Run it without confirm first, show the coach the preview in plain words, and only send confirm: true after their explicit yes. Invites send real emails to real people.\n- Do not invent data. If a value is missing or unreadable, leave it out and list it back to the coach.\n- Be honest about limits (see \"What cannot move\").\n\n# Steps\n1. Intake. Ask what they have: a client list or export (CSV, xlsx, pasted table, screenshot), program or meal-plan PDFs/text, notes, past check-ins or measurements. Anything is fine; partial is fine. Confirm they are on Coach Pro (bulk invite needs it); if the invite fails for that reason, say so and stop.\n2. Parse the clients. Find email (required), name (join first and last), phone (keep the country code if present). Build ONE private note per client from anything useful: goals, injuries, medical notes, tags, programme name, start date, status. Label each part (\"Goal: ...\", \"Injury: ...\"). Drop archived or inactive clients only if the coach says to. Lowercase and de-duplicate emails. Clients with no email cannot be invited here: list them for the coach (they can share an invite link from the app).\n3. Dry run. Show a compact table (name, email, phone, note preview) and the counts: total, with phone, with notes, skipped and why. Ask whether to start with 2 or 3 clients as a test. Call bulk_invite_clients without confirm, ask for the yes, then send in batches of at most 200.\n4. Report every row's outcome (sent, already invited, duplicate, invalid email, failed) from the result. Do not retry blindly; re-running a list is safe because duplicates and pending invites are skipped.\n5. Plans. From PDFs or text, build workout plans with create_workout_plan_template and meal plans with create_diet_plan_template (a client must exist before create_workout_plan or create_diet_plan can assign one). Keep the coach's exercise wording and rep ranges (\"8-10\"). Preview each, confirm, create. Assign after the client connects.\n6. History, once clients have accepted (check list_clients; invites stay pending until the client taps the link). Offer, per client and only for data the coach actually gave you: add_client_progress_history (back-dated weight, measurements, photos; also works before the client finishes onboarding), import_checkin_history (past check-ins and answers). Use exact dates, state the units, and never fill gaps. Notes you attached to the invite are saved to the coach's private client notes automatically when the client connects; use get_coach_client_notes before set_coach_client_notes, because that tool overwrites.\n7. Wrap up: what moved, what is pending (invites not yet accepted), what could not move, and the next step (ask clients to open the invite email and install the app).\n\n# What cannot move\n- You cannot pull anything out of the old platform yourself. Whatever the coach cannot export, stays there.\n- Old workout logs and progress photos only come across if the coach has them as files or text. Otherwise clients start fresh; suggest keeping the old account read-only for a month.\n- Payments and subscriptions with the old platform are not touched. The coach cancels or keeps them themselves.\n- Clients must accept the invite before they exist in Trainzilla; connected-only data waits for that.";

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
