import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { restGet } from "../client.js";
import { guard, READ_ONLY, readTool, writeTool, trainerId } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");

const AI_RUN = `_id clientId clientName type status error rejectionCategory queuedAt startedAt completedAt reviewedAt clientViewedAt
  steps { tool status summary error at } createdArtifacts { kind id }
  rationale { headline inputs { label value note } changes { what why } math { label value note } recordedAt }`;

const CHECKIN = `_id trainerId clientId scheduledFor status acceptedAt rejectedAt respondedAt isOverdue
  logWindowStartsAt logWindowEndsAt client { _id name } questions { id type label required }`;

export function registerAiCheckinsInboxTools(server: McpServer): void {
  /* ── AI coaching: review queue + controls ── */
  readTool(server, {
    name: "list_ai_runs_awaiting_review",
    desc: "AI-generated plans for the coach's own clients that are waiting for approval before the client sees them. Show the rationale and artifacts to the coach, then approve_ai_run or reject_ai_run.",
    field: "myAiRunsAwaitingReview",
    select: AI_RUN,
  });
  writeTool(server, {
    name: "approve_ai_run",
    desc: "Approve an AI-generated plan so it is published to the client. Only after the coach has seen the plan.",
    field: "approveMyAiRun",
    args: "runId: ID!",
    select: "_id status reviewedAt",
    shape: { runId: id },
  });
  writeTool(server, {
    name: "reject_ai_run",
    desc: "Reject an AI-generated plan; the reason and category feed the AI's future behaviour (see get_platform_rejection_trends).",
    field: "rejectMyAiRun",
    args: "runId: ID!, reason: String, category: String",
    select: "_id status rejectionCategory",
    shape: { runId: id, reason: z.string().max(1000).optional(), category: z.string().optional() },
  });
  writeTool(server, {
    name: "requeue_ai_run",
    desc: "Re-run a failed or rejected AI coaching run for the client.",
    field: "requeueAIRun",
    args: "runId: ID!",
    select: "_id status",
    shape: { runId: id },
  });
  writeTool(server, {
    name: "trigger_ai_coach_run",
    desc: "Kick off a fresh AI plan generation for one of the coach's AI-coached clients.",
    field: "triggerAICoachRunForClient",
    args: "clientId: ID!",
    select: "runId status",
    shape: { clientId },
  });
  writeTool(server, {
    name: "offer_ai_coach_to_client",
    desc: "Offer Tzilla AI Coach to a client (they get the invitation in-app).",
    field: "offerAICoachToClient",
    args: "clientId: ID!",
    shape: { clientId },
  });
  readTool(server, {
    name: "get_ai_coach_engagement",
    desc: "How many AI plans were published, how many clients viewed them, view rate and average minutes to view.",
    field: "aiCoachEngagementSummary",
    args: "sinceDays: Int",
    select: "publishedCount viewedCount viewRate avgMinutesToView",
    shape: { sinceDays: z.number().int().min(1).max(365).default(30) },
  });
  readTool(server, {
    name: "get_ai_coach_preferences_for_client",
    desc: "A client's AI-coaching preferences: diet type, allergies, cuisines, equipment, workout days, location and notes.",
    field: "aiCoachPreferencesForUser",
    args: "userId: ID!",
    select: `dietType foodAllergies cuisinePreferences mealsPerDay cookingLevel availableWorkoutDays workoutLocation
      availableEquipment preferredWorkoutTime workoutDurationMins exerciseNotes dietNotes updatedAt`,
    shape: { userId: clientId },
  });
  writeTool(server, {
    name: "set_ai_plans_enabled",
    desc: "Switch whether Tzilla AI plans are offered to this coach's clients (gym setting wins inside a gym; existing subscriptions keep running).",
    field: "updateClientAIPlansEnabled",
    args: "enabled: Boolean!",
    select: "userId",
    shape: { enabled: z.boolean() },
  });
  writeTool(server, {
    name: "set_client_self_cancel_enabled",
    desc: "Allow or block clients from cancelling their own subscription in the app.",
    field: "updateClientSelfCancelEnabled",
    args: "enabled: Boolean!",
    select: "userId",
    shape: { enabled: z.boolean() },
  });

  /* ── Check-ins ── */
  readTool(server, {
    name: "get_checkin",
    desc: "One check-in with its questions and status.",
    field: "checkInById",
    args: "id: ID!",
    select: CHECKIN,
    shape: { id },
  });
  readTool(server, {
    name: "get_checkin_logs",
    desc: "The messages and answers logged against one check-in (client replies and coach notes).",
    field: "checkInLogs",
    args: "checkInId: ID!",
    select: "_id checkInId message createdByRole createdAt answers { questionId value }",
    shape: { checkInId: id },
  });
  writeTool(server, {
    name: "respond_to_checkin",
    desc: "Accept or reject a pending check-in request.",
    field: "respondToCheckIn",
    args: "checkInId: ID!, accept: Boolean!",
    select: CHECKIN,
    shape: { checkInId: id, accept: z.boolean() },
  });
  writeTool(server, {
    name: "add_checkin_log",
    desc: "Add a coach message (and optional answers) to a check-in.",
    field: "addCheckInLog",
    args: "input: AddCheckInLogInput!",
    select: "_id checkInId message createdAt",
    shape: {
      input: z.object({
        checkInId: id,
        message: z.string().min(1),
        answers: z.array(z.object({ questionId: id, value: z.string() })).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "remove_checkin",
    desc: "Delete a check-in.",
    field: "removeCheckIn",
    args: "checkInId: ID!",
    shape: { checkInId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "clear_overdue_checkins",
    desc: "Clear every overdue (never answered) check-in, for one client or for all. Returns how many were cleared.",
    field: "clearOverdueCheckIns",
    args: "clientId: ID",
    shape: { clientId: clientId.optional() },
    destructive: true,
  });

  readTool(server, {
    name: "list_checkin_schedules",
    desc: "The coach's recurring check-in schedules (weekday + time + questions per client).",
    field: "checkInSchedulesForTrainer",
    args: "trainerId: ID!",
    select: "_id clientId dayOfWeek timeOfDay isActive client { _id name } questions { id type label required }",
    resolve: async () => ({ trainerId: await trainerId() }),
  });
  writeTool(server, {
    name: "upsert_checkin_schedule",
    desc: "Create or edit a recurring weekly check-in for a client (dayOfWeek 0=Sunday..6=Saturday). Pass _id to edit.",
    field: "upsertCheckInSchedule",
    args: "input: UpsertCheckInScheduleInput!",
    select: "_id clientId dayOfWeek timeOfDay isActive",
    shape: {
      input: z.object({
        _id: z.string().optional(),
        clientId,
        dayOfWeek: z.number().int().min(0).max(6),
        timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:mm"),
        isActive: z.boolean().optional(),
        questions: z
          .array(z.object({ id: z.string().optional(), type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO"]), label: z.string().min(1), required: z.boolean().optional() }))
          .optional(),
      }),
    },
  });
  writeTool(server, {
    name: "delete_checkin_schedule",
    desc: "Delete a recurring check-in schedule.",
    field: "deleteCheckInSchedule",
    args: "scheduleId: ID!",
    shape: { scheduleId: id },
    destructive: true,
  });

  /* ── Notifications + chat ── */
  readTool(server, {
    name: "list_notifications",
    desc: "The coach's in-app notifications, newest first (paginate with nextCursor).",
    field: "notifications",
    args: "limit: Int, cursor: String",
    select: "nextCursor items { _id category title body data readAt createdAt }",
    shape: { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().optional() },
  });
  readTool(server, {
    name: "get_unread_notification_count",
    desc: "How many notifications are unread.",
    field: "unreadCount",
  });
  writeTool(server, {
    name: "mark_notifications_read",
    desc: "Mark the given notifications read.",
    field: "markRead",
    args: "ids: [ID!]!",
    shape: { ids: z.array(id).min(1) },
  });
  writeTool(server, {
    name: "mark_all_notifications_read",
    desc: "Mark every notification read.",
    field: "markAllRead",
  });
  readTool(server, {
    name: "get_client_chat_messages",
    desc: "Chat history with one of the coach's own clients, oldest first (page back with `before`). Shows what the client replied; use send_message_to_client to answer.",
    field: "clientChatMessages",
    args: "clientId: ID!, before: Date, limit: Int",
    select: "id roomId from fromRole type text mediaUrl createdAt readByClient",
    shape: { clientId, before: z.string().optional().describe("ISO time; return messages older than this"), limit: z.number().int().min(1).max(100).default(30) },
  });
  server.tool(
    "list_chat_rooms",
    "The coach's recent chat conversations (up to 50, newest first) with participants and last-message time. Read a conversation with get_client_chat_messages; reply with send_message_to_client.",
    {},
    READ_ONLY,
    async () => guard(() => restGet("/api/chat/chats"))
  );
}
