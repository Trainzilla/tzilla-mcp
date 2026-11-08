import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { gql } from "../client.js";
import { confirmField, guard, readTool, REGISTERED_DOCS, WRITE, writeTool } from "../kit.js";

const id = z.string().min(1);

const ITEM_SELECT = `id type dayOffset time repeat { everyDays everyWeeks untilDay }
  payload { text via templateId title durationDays habitId sessionType durationMinutes meetingLink sessionNotes bookAheadDays questions { id type label required options } }`;
const PROGRAM_LIST = `id name description lengthDays version archived activeEnrollmentCount updatedAt`;
const PROGRAM_FULL = `${PROGRAM_LIST} items { ${ITEM_SELECT} }`;
const ENROLLMENT = `id programId programName clientId clientName startDate timeZone status lengthDays customised behindTemplate createdAt updatedAt`;
const OUTCOME = `assignmentId preview createdCount skippedCount failedCount rows { clientId name itemId status reason }`;
const OCCURRENCE = `id enrollmentId programId clientId itemId itemType occurrence dayIndex scheduledFor status reason resultId`;

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-MM-dd");

const questionShape = z.object({
  type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO", "YES_NO", "CHOICE"]),
  label: z.string().min(1),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1)).min(2).max(10).optional().describe("CHOICE only"),
});

/** One thing in a program. dayOffset 0 is Day 1 (the day the client starts); there are no calendar dates in a program. */
const itemShape = z.object({
  id: id.optional().describe("Keep the id from get_program when editing an existing item; leave out for a new one"),
  type: z.enum(["MESSAGE", "CHECKIN", "WORKOUT", "NUTRITION", "HABIT", "SESSION"]).describe("CHECKIN is the photo / check-in request"),
  dayOffset: z.number().int().min(0).max(729).describe("0 = Day 1, 14 = Day 15"),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe("HH:mm in the client's time zone; default 09:00"),
  repeat: z
    .object({
      everyDays: z.number().int().min(1).max(365).optional(),
      everyWeeks: z.number().int().min(1).max(52).optional(),
      untilDay: z.number().int().min(0).optional().describe("Last day offset (inclusive); leave out to repeat to the end of the program"),
    })
    .optional()
    .describe("Set everyDays OR everyWeeks, never both. Leave out for a one-off"),
  payload: z
    .object({
      text: z.string().max(2000).optional().describe("MESSAGE: the text. {{clientName}} and {{coachName}} are filled in"),
      via: z.enum(["chat", "push", "email"]).optional().describe("MESSAGE: default chat"),
      questions: z.array(questionShape).optional().describe("CHECKIN: the questions (include a PHOTO question for progress photos)"),
      templateId: id.optional().describe("WORKOUT / NUTRITION: a plan template id (list_workout_plan_templates / list_diet_plan_templates)"),
      title: z.string().optional().describe("WORKOUT / NUTRITION: title for the client's plan"),
      durationDays: z.number().int().min(1).max(730).optional().describe("WORKOUT / NUTRITION: how long the plan runs"),
      habitId: id.optional().describe("HABIT: a master habit id"),
      sessionType: z.enum(["online", "in_person"]).optional().describe("SESSION"),
      durationMinutes: z.number().int().min(5).max(480).optional().describe("SESSION"),
      meetingLink: z.string().optional().describe("SESSION online: required"),
      sessionNotes: z.string().optional(),
      bookAheadDays: z.number().int().min(0).max(30).optional().describe("SESSION: booked this many days early (default 7)"),
    })
    .default({}),
});

/**
 * Programs (Coach Pro / gym): a program is a saved timeline of messages, photo requests, workout and nutrition plans,
 * habits and sessions on Day 1, Day 2 ... that is copied to each client who starts it. Reuses the same plans, habits,
 * check-ins and sessions as everywhere else. Backend: tzilla-be modules/programs.
 */
export function registerProgramTools(server: McpServer): void {
  readTool(server, {
    name: "list_programs",
    desc: "The coach's programs (name, length in days, version, how many clients are on each). Programs are Coach Pro / gym.",
    field: "programs",
    args: "includeArchived: Boolean",
    select: PROGRAM_LIST,
    shape: { includeArchived: z.boolean().optional() },
  });
  readTool(server, {
    name: "get_program",
    desc: "One program with every item: type, dayOffset (0 = Day 1), time, repeat and payload. Read this before update_program.",
    field: "program",
    args: "id: ID!",
    select: PROGRAM_FULL,
    shape: { id },
  });
  writeTool(server, {
    name: "create_program",
    desc: "Create a program: a name, a length in days (1-730) and its items. Day 1 is dayOffset 0. Everything is validated when saved (a message needs text, a workout/nutrition item needs a template, an online session needs a link). Nothing is sent to anyone until you enrol clients.",
    field: "createProgram",
    args: "input: ProgramInput!",
    select: PROGRAM_FULL,
    shape: {
      input: z.object({
        name: z.string().min(1).max(120),
        description: z.string().optional(),
        lengthDays: z.number().int().min(1).max(730),
        items: z.array(itemShape).max(300).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "update_program",
    desc: "Edit a program. `items`, if given, REPLACES the whole list: call get_program first and send back every item you want to keep (with their ids). Clients already on the program keep their own copy until push_program_to_clients.",
    field: "updateProgram",
    args: "id: ID!, input: UpdateProgramInput!",
    select: PROGRAM_FULL,
    shape: {
      id,
      input: z.object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().optional(),
        lengthDays: z.number().int().min(1).max(730).optional(),
        items: z.array(itemShape).max(300).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "archive_program",
    desc: "Archive (hide) a program, or restore it with archived: false. Clients already on it keep running from their own copy.",
    field: "archiveProgram",
    args: "id: ID!, archived: Boolean!",
    select: "id name archived",
    shape: { id, archived: z.boolean() },
  });

  /* ── Starting a program for clients ── */
  const ENROLL_DOC = `mutation ProgramEnroll($programId: ID!, $options: EnrollInProgramOptions!) { enrollInProgram(programId: $programId, options: $options) { ${OUTCOME} } }`;
  REGISTERED_DOCS.push({ tool: "enroll_clients_in_program", doc: ENROLL_DOC });
  server.tool(
    "enroll_clients_in_program",
    "Start a program for some clients and/or groups, with Day 1 on startDate (yyyy-MM-dd). Confirm-gated: without confirm the server previews who would start and who would be skipped (and why), writing nothing. Show that list to the coach, then confirm: true. Each client gets their own copy, so one can be changed later. Undo with undo_program_assignment.",
    {
      programId: id,
      startDate: dateKey.describe("Day 1"),
      clientIds: z.array(id).max(40).optional().describe("Client User _ids (from list_clients)"),
      groupIds: z.array(id).max(10).optional().describe("Group ids (from list_client_groups)"),
      excludeClientIds: z.array(id).optional(),
      allowDuplicates: z.boolean().optional().describe("Also start a client who is already on this program"),
      timeZone: z.string().optional().describe("IANA zone; default is each client's own"),
      ...confirmField,
    },
    WRITE,
    async ({ confirm, programId, ...options }) => {
      if (!options.clientIds?.length && !options.groupIds?.length) return guard(async () => { throw new Error("Give clientIds and/or groupIds"); });
      return guard(async () => {
        const key = confirm ? createHash("sha256").update(JSON.stringify([programId, options, Math.floor(Date.now() / 600_000)])).digest("hex").slice(0, 40) : undefined;
        const data = await gql<{ enrollInProgram: unknown }>(ENROLL_DOC, { programId, options: { ...options, preview: !confirm, ...(key ? { requestKey: key } : {}) } });
        return confirm ? data.enrollInProgram : { status: "preview", action: "enroll_clients_in_program", outcome: data.enrollInProgram, note: "Nothing was written. Re-run with confirm: true to start the program for these clients." };
      });
    }
  );
  writeTool(server, {
    name: "undo_program_assignment",
    desc: "Stop every enrollment one enroll_clients_in_program call made (assignmentId from its result). What was already sent stays with the clients.",
    field: "undoProgramAssignment",
    args: "assignmentId: ID!",
    select: OUTCOME,
    shape: { assignmentId: id },
    destructive: true,
  });
  const PUSH_DOC = `mutation ProgramPush($programId: ID!, $preview: Boolean) { pushProgramToEnrollments(programId: $programId, preview: $preview) { ${OUTCOME} } }`;
  REGISTERED_DOCS.push({ tool: "push_program_to_clients", doc: PUSH_DOC });
  server.tool(
    "push_program_to_clients",
    "Give the program's current items to every client on it whose copy the coach has not edited by hand. Confirm-gated: without confirm it previews who would be updated. Items already sent are not re-sent.",
    { programId: id, ...confirmField },
    WRITE,
    async ({ confirm, programId }) =>
      guard(async () => {
        const data = await gql<{ pushProgramToEnrollments: unknown }>(PUSH_DOC, { programId, preview: !confirm });
        return confirm ? data.pushProgramToEnrollments : { status: "preview", action: "push_program_to_clients", outcome: data.pushProgramToEnrollments, note: "Nothing changed. Re-run with confirm: true." };
      })
  );

  /* ── Following and managing one client's enrollment ── */
  readTool(server, {
    name: "list_program_enrollments",
    desc: "Who is on a program, or which programs a client is on: status (ACTIVE, PAUSED, COMPLETED, CANCELLED), start date (Day 1), whether the coach edited their copy, and whether the program changed since they started.",
    field: "programEnrollments",
    args: "programId: ID, clientId: ID, status: ProgramEnrollmentStatus, limit: Int",
    select: ENROLLMENT,
    shape: {
      programId: id.optional(),
      clientId: id.optional().describe("Client User _id"),
      status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]).optional(),
      limit: z.number().int().min(1).max(300).optional(),
    },
  });
  readTool(server, {
    name: "get_program_enrollment",
    desc: "One client's copy of a program, with its items.",
    field: "programEnrollment",
    args: "id: ID!",
    select: `${ENROLLMENT} items { ${ITEM_SELECT} }`,
    shape: { id },
  });
  writeTool(server, {
    name: "pause_program_enrollment",
    desc: "Pause one client's program: nothing more goes out until it is resumed.",
    field: "pauseProgramEnrollment",
    args: "id: ID!",
    select: ENROLLMENT,
    shape: { id },
  });
  writeTool(server, {
    name: "resume_program_enrollment",
    desc: "Resume a paused program. By default the rest of the schedule slides forward by the days it was paused (shiftSchedule false keeps the original days).",
    field: "resumeProgramEnrollment",
    args: "id: ID!, shiftSchedule: Boolean",
    select: ENROLLMENT,
    shape: { id, shiftSchedule: z.boolean().optional() },
  });
  writeTool(server, {
    name: "shift_program_enrollment_start",
    desc: "Move a client's Day 1 to a new date (yyyy-MM-dd); everything after it moves too. Things already sent are not re-sent.",
    field: "shiftProgramEnrollmentStart",
    args: "id: ID!, startDate: String!",
    select: ENROLLMENT,
    shape: { id, startDate: dateKey },
  });
  writeTool(server, {
    name: "cancel_program_enrollment",
    desc: "Stop a program for one client. What they already received stays; this cannot be undone (enrol them again to restart).",
    field: "cancelProgramEnrollment",
    args: "id: ID!",
    select: ENROLLMENT,
    shape: { id },
    destructive: true,
  });
  writeTool(server, {
    name: "edit_program_enrollment",
    desc: "Edit just this client's copy of a program (the program and other clients are untouched). `items` REPLACES the copy's list: get_program_enrollment first and send back everything to keep.",
    field: "editProgramEnrollment",
    args: "id: ID!, lengthDays: Int, items: [ProgramItemInput!]!",
    select: `${ENROLLMENT} items { ${ITEM_SELECT} }`,
    shape: { id, lengthDays: z.number().int().min(1).max(730).optional(), items: z.array(itemShape).max(300) },
  });
  readTool(server, {
    name: "list_program_occurrences",
    desc: "What a program has sent so far, one row per item per day per client, with status (DONE, FAILED, SKIPPED, PENDING) and the reason. Filter to one enrollment, program, client or status (FAILED shows what needs a retry).",
    field: "programOccurrences",
    args: "enrollmentId: ID, programId: ID, clientId: ID, status: ProgramOccurrenceStatus, limit: Int",
    select: OCCURRENCE,
    shape: {
      enrollmentId: id.optional(),
      programId: id.optional(),
      clientId: id.optional(),
      status: z.enum(["PENDING", "DONE", "FAILED", "SKIPPED"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
  });
  writeTool(server, {
    name: "retry_program_occurrence",
    desc: "Run one FAILED program item again now. Nothing is retried automatically, so this never double-sends by itself.",
    field: "retryProgramOccurrence",
    args: "id: ID!",
    select: "id status reason resultId",
    shape: { id },
  });
}
