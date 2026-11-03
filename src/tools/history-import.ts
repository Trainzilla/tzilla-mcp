import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gql, isHttpRequest } from "../client.js";
import { confirmField, fail, guard, preview, readTool, trainerId, REGISTERED_DOCS, WRITE } from "../kit.js";
import { TYPES, uploadBytes } from "./secrets-uploads.js";

/**
 * Importing a client's HISTORY: past check-ins with the answers the client gave, and back-dated
 * weight / measurements / progress photos. Both batch tools are confirm-gated and write nothing
 * without confirm: true; both skip rows that are already there, so a retry is safe.
 */

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");

const LB_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const SITES = ["neck", "waist", "hip", "chest", "arm", "thigh"] as const;

/** Noon UTC keeps the calendar day right in every time zone; for today it can still be ahead of now, so use just before now. */
export function momentFor(date: string, now: number = Date.now()): string {
  const noon = new Date(`${date}T12:00:00.000Z`).getTime();
  return new Date(noon < now ? noon : now - 60_000).toISOString();
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export type ProgressRowInput = {
  date: string;
  weight?: number;
  measurements?: Partial<Record<(typeof SITES)[number], number>>;
  photos?: string[];
  notes?: string;
};

/** One tool row → the API's metric `CoachProgressEntryInput` (weight in kg, lengths in cm). */
export function toProgressEntry(row: ProgressRowInput, units: "metric" | "imperial", photoKeys: string[]) {
  const w = units === "imperial" ? LB_TO_KG : 1;
  const l = units === "imperial" ? IN_TO_CM : 1;
  const measurements: Record<string, number> = {};
  for (const site of SITES) {
    const v = row.measurements?.[site];
    if (v != null) measurements[`${site}Cm`] = round1(v * l);
  }
  return {
    dateISO: row.date,
    ...(row.weight != null ? { weightKg: round1(row.weight * w) } : {}),
    ...(Object.keys(measurements).length ? { measurements } : {}),
    ...(photoKeys.length ? { imageUrls: photoKeys } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
  };
}

/** Answers keyed by question label → [{questionId, value}] against the question ids the server assigned. */
export function mapAnswers(
  questions: { id: string; label: string }[],
  answers: Record<string, string | number> | undefined,
): { answers: { questionId: string; value: string }[]; unmatched: string[] } {
  const byLabel = new Map(questions.map((q) => [q.label.trim().toLowerCase(), q.id]));
  const out: { questionId: string; value: string }[] = [];
  const unmatched: string[] = [];
  for (const [label, value] of Object.entries(answers ?? {})) {
    const qid = byLabel.get(label.trim().toLowerCase());
    if (!qid) unmatched.push(label);
    else out.push({ questionId: qid, value: String(value) });
  }
  return { answers: out, unmatched };
}

const questionSchema = z.object({
  label: z.string().min(1),
  type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO", "YES_NO", "CHOICE"]).default("TEXT"),
  options: z.array(z.string()).optional().describe("CHOICE only"),
});

const checkinRow = z.object({
  date: day.describe("The day the check-in happened (past)"),
  questions: z.array(questionSchema).optional().describe("The questions asked that day; omit for a note-only check-in"),
  answers: z
    .record(z.union([z.string(), z.number()]))
    .optional()
    .describe('The client\'s answers keyed by question label, e.g. {"Weight (lb)": 154, "Energy": "7"}'),
  note: z.string().optional().describe("Free text to save with the check-in"),
});

const progressRow = z.object({
  date: day,
  weight: z.number().positive().optional().describe("In `units` (kg, or lb when imperial)"),
  measurements: z
    .object(Object.fromEntries(SITES.map((s) => [s, z.number().positive().optional()])) as Record<(typeof SITES)[number], z.ZodOptional<z.ZodNumber>>)
    .partial()
    .optional()
    .describe("Tape measurements in `units` (cm, or inches when imperial): neck, waist, hip, chest, arm, thigh"),
  photos: z.array(id).max(6).optional().describe("S3 keys from upload_file"),
  photoFiles: z.array(z.string()).max(6).optional().describe("Local image paths to upload first (local stdio server only)"),
  notes: z.string().max(1000).optional(),
});

export function registerHistoryImportTools(server: McpServer): void {
  REGISTERED_DOCS.push(
    {
      tool: "import_checkin_history",
      doc: `mutation Tool($input: CreateCheckInInput!) { createCheckIn(input: $input) { _id questions { id label } } }`,
    },
    {
      tool: "import_checkin_history",
      doc: `mutation Tool($input: AddCheckInLogInput!) { addCheckInLog(input: $input) { _id } }`,
    },
    {
      tool: "import_checkin_history",
      doc: `query Tool($trainerId: ID!, $clientId: ID, $pagination: PaginationInput) { checkInsForTrainer(trainerId: $trainerId, clientId: $clientId, pagination: $pagination) { _id scheduledFor } }`,
    },
    {
      tool: "add_client_progress_history",
      doc: `mutation Tool($userId: ID!, $entries: [CoachProgressEntryInput!]!) { addClientProgressHistory(userId: $userId, entries: $entries) { saved duplicatesSkipped pendingOnboarding } }`,
    },
  );

  server.tool(
    "import_checkin_history",
    "Load a client's PAST check-ins with the answers they gave (batch, confirm-gated). Each row becomes a check-in on its past date " +
      "(created already accepted; the client gets no notification) with the answers saved on it as the coach's entry, dated to that day. " +
      "Days that already have a check-in for this client are skipped, so re-running is safe. Rows run one at a time; a failed row is reported and the rest continue. " +
      "Answer keys must match a question label from the same row. Up to 50 rows per call.",
    {
      clientId,
      checkins: z.array(checkinRow).min(1).max(50),
      ...confirmField,
    },
    WRITE,
    async ({ clientId: cid, checkins, confirm }) => {
      if (!confirm) {
        return preview("import_checkin_history", {
          clientId: cid,
          checkins: checkins.length,
          dates: checkins.map((c) => c.date),
          withAnswers: checkins.filter((c) => c.answers && Object.keys(c.answers).length).length,
          note: "Existing check-ins on the same day are skipped.",
        });
      }
      return guard(async () => {
        const tid = await trainerId();
        const existingDays = new Set<string>();
        for (let pageNumber = 1; pageNumber <= 10; pageNumber++) {
          const data = await gql<{ checkInsForTrainer: { scheduledFor: string }[] }>(
            `query Tool($trainerId: ID!, $clientId: ID, $pagination: PaginationInput) { checkInsForTrainer(trainerId: $trainerId, clientId: $clientId, pagination: $pagination) { _id scheduledFor } }`,
            { trainerId: tid, clientId: cid, pagination: { pageNumber, pageSize: 100 } },
          );
          for (const c of data.checkInsForTrainer) existingDays.add(new Date(c.scheduledFor).toISOString().slice(0, 10));
          if (data.checkInsForTrainer.length < 100) break;
        }

        const results: Record<string, unknown>[] = [];
        for (const row of checkins) {
          if (existingDays.has(row.date)) {
            results.push({ date: row.date, status: "skipped", reason: "a check-in already exists that day" });
            continue;
          }
          let checkInId: string | undefined;
          try {
            const when = momentFor(row.date);
            const questions = (row.questions ?? []).map((q) => ({ id: randomUUID(), type: q.type, label: q.label, required: false, options: q.options }));
            const created = await gql<{ createCheckIn: { _id: string; questions: { id: string; label: string }[] } }>(
              `mutation Tool($input: CreateCheckInInput!) { createCheckIn(input: $input) { _id questions { id label } } }`,
              { input: { trainerId: tid, clientId: cid, scheduledFor: when, questions } },
            );
            checkInId = created.createCheckIn._id;
            const { answers, unmatched } = mapAnswers(created.createCheckIn.questions, row.answers);
            let logged = false;
            if (answers.length || row.note?.trim()) {
              await gql(
                `mutation Tool($input: AddCheckInLogInput!) { addCheckInLog(input: $input) { _id } }`,
                {
                  input: {
                    checkInId,
                    message: row.note?.trim() || "Imported from the coach's records",
                    answers: answers.length ? answers : undefined,
                    loggedAt: when,
                  },
                },
              );
              logged = true;
            }
            results.push({
              date: row.date,
              status: "created",
              checkInId,
              answersSaved: answers.length,
              ...(logged ? {} : { note: "no answers or note to save" }),
              ...(unmatched.length ? { unmatchedAnswerLabels: unmatched } : {}),
            });
          } catch (e) {
            results.push({
              date: row.date,
              status: "failed",
              ...(checkInId ? { checkInId, hint: "the check-in exists but its answers were not saved; add them with add_checkin_log" } : {}),
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        const count = (s: string) => results.filter((r) => r.status === s).length;
        return { created: count("created"), skipped: count("skipped"), failed: count("failed"), results };
      });
    },
  );

  server.tool(
    "add_client_progress_history",
    "Load a client's past weight, tape measurements (chest, arm, thigh, waist, hip, neck) and progress photos with back-dated days (batch, confirm-gated, up to 100 rows). " +
      "Works for a client who has not finished app onboarding too: the rows are held and appear on their timeline when they onboard (see list_pending_client_progress). " +
      "Rows identical to ones already saved are skipped, so a retry is safe. Set units to imperial to send lb and inches. " +
      "Photos: S3 keys from upload_file, or local file paths in photoFiles (uploaded first; local server only).",
    {
      clientId,
      units: z.enum(["metric", "imperial"]).default("metric").describe("metric = kg + cm; imperial = lb + inches"),
      entries: z.array(progressRow).min(1).max(100),
      ...confirmField,
    },
    WRITE,
    async ({ clientId: cid, units, entries, confirm }) => {
      if (entries.some((e) => e.photoFiles?.length) && isHttpRequest()) {
        return fail("photoFiles is only available on a local (stdio) server; upload with upload_file and pass photos (keys) instead.");
      }
      if (!confirm) {
        return preview("add_client_progress_history", {
          clientId: cid,
          units,
          entries: entries.map((e) => ({ ...e, photoFiles: e.photoFiles?.length ? `${e.photoFiles.length} file(s) to upload` : undefined })),
        });
      }
      return guard(async () => {
        const prepared = [];
        for (const row of entries) {
          const keys = [...(row.photos ?? [])];
          for (const file of row.photoFiles ?? []) {
            const type = TYPES[path.extname(file).toLowerCase()];
            if (!type?.startsWith("image/")) throw new Error(`${file}: only image files can be progress photos.`);
            keys.push((await uploadBytes(await readFile(file), type)).key);
          }
          prepared.push(toProgressEntry(row, units, keys));
        }
        const data = await gql<{ addClientProgressHistory: unknown }>(
          `mutation Tool($userId: ID!, $entries: [CoachProgressEntryInput!]!) { addClientProgressHistory(userId: $userId, entries: $entries) { saved duplicatesSkipped pendingOnboarding } }`,
          { userId: cid, entries: prepared },
        );
        return data.addClientProgressHistory;
      });
    },
  );

  readTool(server, {
    name: "list_pending_client_progress",
    desc: "Progress rows entered (or health reports accepted) for a client who has not finished app onboarding yet; they join the client's timeline when they onboard.",
    field: "pendingProgressForClient",
    args: "userId: ID!",
    select: "id dateISO weightKg measurements { waistCm hipCm chestCm armCm thighCm neckCm } imageUrls notes source",
    shape: { userId: clientId },
  });
}
