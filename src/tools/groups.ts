import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { groupAssignTool, readTool, writeTool } from "../kit.js";

const id = z.string().min(1);

const GROUP = `id name description color memberCount createdAt updatedAt`;
const GROUP_WITH_MEMBERS = `${GROUP} members { clientId name addedAt }`;
const OUTCOME = `assignmentId preview createdCount skippedCount failedCount rows { clientId name itemId status reason }`;

const checkInQuestion = z.object({
  type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO", "YES_NO", "CHOICE"]),
  label: z.string().min(1),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1)).min(2).max(10).optional().describe("CHOICE only: the answers to pick from"),
});

/**
 * Client groups (Coach Pro / gym): a coach's named lists of clients. Anything done "to a group" is done to each
 * member as an ordinary per-client item, so it shows up on each client exactly as if made one by one.
 */
export function registerGroupTools(server: McpServer): void {
  /* ── The groups themselves ── */
  readTool(server, {
    name: "list_client_groups",
    desc: "The coach's client groups (name, size). Groups are Coach Pro / gym; a free coach gets an error from the write tools.",
    field: "myClientGroups",
    select: GROUP,
  });
  readTool(server, {
    name: "get_client_group",
    desc: "One group with its members (client ids and names). Use the clientId values with the other client tools.",
    field: "clientGroup",
    args: "id: ID!",
    select: GROUP_WITH_MEMBERS,
    shape: { id },
  });
  readTool(server, {
    name: "list_groups_for_client",
    desc: "Which of the coach's groups a client belongs to.",
    field: "clientGroupsForClient",
    args: "clientId: ID!",
    select: GROUP,
    shape: { clientId: id },
  });
  writeTool(server, {
    name: "create_client_group",
    desc: "Create a group, optionally with starting members (clientIds must be the coach's own clients). Names are unique per coach.",
    field: "createClientGroup",
    args: "input: CreateClientGroupInput!",
    select: GROUP,
    shape: {
      input: z.object({
        name: z.string().min(2).max(60),
        description: z.string().max(300).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("#rrggbb"),
        clientIds: z.array(id).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "update_client_group",
    desc: "Rename or recolour a group, or change its description.",
    field: "updateClientGroup",
    args: "id: ID!, input: UpdateClientGroupInput!",
    select: GROUP,
    shape: {
      id,
      input: z.object({
        name: z.string().min(2).max(60).optional(),
        description: z.string().max(300).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "delete_client_group",
    desc: "Delete a group. Only the list goes: plans, habits, check-ins and sessions already given to its members are kept.",
    field: "deleteClientGroup",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });
  writeTool(server, {
    name: "add_group_members",
    desc: "Add clients to a group (the coach's own clients only; adding someone already in it is harmless; up to 200 per group).",
    field: "addClientGroupMembers",
    args: "groupId: ID!, clientIds: [ID!]!",
    select: GROUP,
    shape: { groupId: id, clientIds: z.array(id).min(1) },
  });
  writeTool(server, {
    name: "remove_group_members",
    desc: "Take clients out of a group. Their plans and habits are not touched.",
    field: "removeClientGroupMembers",
    args: "groupId: ID!, clientIds: [ID!]!",
    select: GROUP,
    shape: { groupId: id, clientIds: z.array(id).min(1) },
  });

  /* ── Seeing how a group is doing ── */
  readTool(server, {
    name: "get_group_overview",
    desc: "How each member of a group is doing: workout days and food-log days in the last 7 days, last log dates, and unanswered check-ins. Use it to say who needs a nudge.",
    field: "groupOverview",
    args: "groupId: ID!",
    select: "clientId name workoutDays7 mealDays7 lastWorkoutDate lastMealDate overdueCheckIns",
    shape: { groupId: id },
  });
  readTool(server, {
    name: "list_group_assignments",
    desc: "What the coach has given to groups (workouts, nutrition plans, habits, messages, check-ins, sessions), newest first, with the per-client result. Use an assignmentId with undo_group_assignment.",
    field: "groupAssignments",
    args: "groupId: ID, limit: Int",
    select: "id kind title groupIds undone createdAt rows { clientId name status reason }",
    shape: { groupId: id.optional(), limit: z.number().int().min(1).max(100).optional() },
  });

  /* ── Doing something for every member (preview first, then confirm) ── */
  groupAssignTool(server, {
    name: "assign_habit_to_groups",
    desc: "Give a reusable Master Habit (from master_habits) to every client in one or more groups. Members who already have a habit with that name are skipped.",
    field: "assignHabitToGroups",
    sig: "$masterHabitId: ID!",
    shape: { masterHabitId: id },
  });
  groupAssignTool(server, {
    name: "message_groups",
    desc: "Send the same message to every client in one or more groups, in each client's own chat with the coach. A sent message cannot be taken back, so show the text and the recipient list first.",
    field: "sendMessageToGroups",
    sig: "$text: String!",
    shape: { text: z.string().min(1).max(1000) },
  });
  groupAssignTool(server, {
    name: "schedule_checkin_for_groups",
    desc: "Give every client in one or more groups the same recurring weekly check-in (day, time, optional questions). Members who already have a weekly check-in are skipped.",
    field: "scheduleCheckInForGroups",
    sig: "$input: GroupCheckInInput!",
    shape: {
      input: z.object({
        dayOfWeek: z.number().int().min(0).max(6).describe("0 = Sunday ... 6 = Saturday"),
        timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe("HH:MM, 24-hour, in the coach's time zone"),
        intervalWeeks: z.number().int().min(1).max(4).optional().describe("1 = weekly (default), 2 = every other week ..."),
        timeZone: z.string().optional(),
        questions: z.array(checkInQuestion).optional(),
      }),
    },
  });
  groupAssignTool(server, {
    name: "book_session_for_groups",
    desc: "Book the same slot for every client in one or more groups: each gets their own session at the same time with the same meeting link. The slot must be inside the coach's working hours and free. Online sessions need a meetingLink (in-app video and Google Meet are not available for group sessions).",
    field: "bookSessionForGroups",
    sig: "$input: GroupSessionInput!",
    shape: {
      input: z.object({
        type: z.enum(["ONLINE", "IN_PERSON"]),
        scheduledStart: z.string().min(1).describe("ISO date-time"),
        scheduledEnd: z.string().min(1),
        meetingLink: z.string().url().optional(),
        notes: z.object({ trainer: z.string().optional(), client: z.string().optional() }).optional(),
      }),
    },
  });

  writeTool(server, {
    name: "undo_group_assignment",
    desc: "Take back a group assignment (get the id from list_group_assignments): removes the plans, habits and check-in schedules it created and cancels the sessions it booked (clients are told). Copies the coach has edited are kept. A sent message cannot be taken back. Works once per assignment.",
    field: "undoGroupAssignment",
    args: "assignmentId: ID!",
    select: OUTCOME,
    shape: { assignmentId: id },
    destructive: true,
  });
}
