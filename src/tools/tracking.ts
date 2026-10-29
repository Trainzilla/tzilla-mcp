import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");

const DIET_LOG = `id clientId date planId planMealOrder name description calories
  macros { protein carbs fat fiber sugar sodiumMg } quantity source compliance imageUrl notes createdAt`;
const WORKOUT_LOG = `id clientId date planId planExerciseOrder name
  sets { set reps weightKg restSeconds rir e1rmKg isPr prKinds }
  totalSets repsPerSet restSeconds durationSeconds rpe weightKg source compliance imageUrl notes loggedByRole
  prescribedSets prescribedReps personalRecords { kind set valueKg previousKg weightKg reps }`;

export function registerTrackingTools(server: McpServer): void {
  /* ── What the client actually did ── */
  readTool(server, {
    name: "get_client_diet_logs",
    desc: "Meals a client logged (what they actually ate) for one day. Shows planned vs extra, compliance and photos.",
    field: "dietLogsByDate",
    args: "clientId: ID!, date: String!",
    select: DIET_LOG,
    shape: { clientId, date: day },
  });
  readTool(server, {
    name: "get_client_diet_logs_range",
    desc: "Meals a client logged between two dates (inclusive) — use for weekly adherence reviews.",
    field: "dietLogsByDateRange",
    args: "clientId: ID!, startDate: String!, endDate: String!",
    select: DIET_LOG,
    shape: { clientId, startDate: day, endDate: day },
  });
  readTool(server, {
    name: "get_client_workout_logs",
    desc: "Exercises a client logged for one day: sets, reps, weights, RPE/RIR, PRs and compliance.",
    field: "workoutLogsByDate",
    args: "clientId: ID!, date: String!",
    select: WORKOUT_LOG,
    shape: { clientId, date: day },
  });
  readTool(server, {
    name: "get_client_workout_logs_range",
    desc: "Exercises a client logged between two dates (inclusive).",
    field: "workoutLogsByDateRange",
    args: "clientId: ID!, startDate: String!, endDate: String!",
    select: WORKOUT_LOG,
    shape: { clientId, startDate: day, endDate: day },
  });
  readTool(server, {
    name: "get_client_daily_metrics",
    desc: "Daily steps, water glasses, resting heart rate, active calories and sleep a client logged, over a date range.",
    field: "dailyMetricsInRange",
    args: "clientId: ID!, startDate: String!, endDate: String!",
    select: "id clientId date steps glasses restingHeartRate activeCaloriesBurned sleepMinutes",
    shape: { clientId, startDate: day, endDate: day },
  });
  readTool(server, {
    name: "get_client_personal_bests",
    desc: "Best weight and estimated 1RM per exercise for a client, most recent PR first.",
    field: "personalBests",
    args: "clientId: ID!, limit: Int",
    select: "exerciseName bestWeightKg bestWeightReps bestWeightDate bestE1rmKg bestE1rmDate lastPrDate sessions",
    shape: { clientId, limit: z.number().int().min(1).max(200).default(50) },
  });
  readTool(server, {
    name: "get_exercise_history",
    desc: "Heaviest weight per session for one exercise of a client — the progression curve.",
    field: "exerciseHistory",
    args: "clientId: ID!, exerciseName: String!, limit: Int",
    select: "date maxWeightKg",
    shape: { clientId, exerciseName: z.string().min(1), limit: z.number().int().min(1).max(200).default(30) },
  });
  readTool(server, {
    name: "get_exercise_stats",
    desc: "A client's personal record, average and last-week weight for one exercise.",
    field: "exerciseStats",
    args: "clientId: ID!, exerciseName: String!",
    select: "personalRecord averageWeight lastWeekWeight",
    shape: { clientId, exerciseName: z.string().min(1) },
  });
  readTool(server, {
    name: "get_client_progress",
    desc: "A client's progress timeline: weight, body measurements, notes, photos and source (manual, health report, smart scale). Optionally limit to a date range.",
    field: "progressReport",
    args: "userId: ID!, range: ProgressRange",
    select: "id dateISO weightKg measurements { neckCm waistCm hipCm bodyFatPct leanMassKg muscleMassKg } notes source bmi tdee caloriesRecommended",
    shape: {
      userId: clientId,
      range: z.object({ fromISO: z.string().optional(), toISO: z.string().optional() }).optional(),
    },
  });
  readTool(server, {
    name: "get_client_weight_unit",
    desc: "The client's display unit for weights (kg or lbs). Lifts are stored in kg.",
    field: "clientWeightUnit",
    args: "clientId: ID!",
    shape: { clientId },
  });
  readTool(server, {
    name: "get_client_session_usage",
    desc: "Per-subscription session pack usage for a client: allowance, used, left, upcoming, no-shows, pauses and when sessions run out.",
    field: "clientSessionUsage",
    args: "clientId: ID!",
    select: `subscriptionId planId planName cycleStart cycleEnd allowance attended noShows upcoming used left
      runOutAt paused pausedUntil validUntil sessionsLow`,
    shape: { clientId },
  });

  /* ── Coach logging on a client's behalf ── */
  writeTool(server, {
    name: "log_client_diet",
    desc: "Log a meal for a client on their behalf.",
    field: "addDietLog",
    args: "input: CreateDietLogInput!",
    select: DIET_LOG,
    shape: {
      input: z.object({
        clientId,
        date: day,
        name: z.string().min(1),
        description: z.string().optional(),
        calories: z.number().optional(),
        macros: z.object({ protein: z.number(), carbs: z.number(), fat: z.number() }).passthrough().optional(),
        quantity: z.string().optional(),
        source: z.enum(["PLANNED", "EXTRA"]).default("EXTRA"),
        compliance: z.enum(["ON_PLAN", "OFF_PLAN", "PARTIAL"]).default("ON_PLAN"),
        planId: z.string().optional(),
        planMealOrder: z.number().int().optional(),
        notes: z.string().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "log_client_workout",
    desc: "Log an exercise for a client on their behalf, with per-set reps and weight (kg).",
    field: "addWorkoutLog",
    args: "input: CreateWorkoutLogInput!",
    select: WORKOUT_LOG,
    shape: {
      input: z.object({
        clientId,
        date: day,
        name: z.string().min(1),
        sets: z
          .array(z.object({ set: z.number().int().min(1), reps: z.number().int().min(0), weightKg: z.number().optional(), restSeconds: z.number().int().optional(), rir: z.number().int().optional() }))
          .optional(),
        durationSeconds: z.number().int().optional(),
        rpe: z.number().int().min(1).max(10).optional(),
        source: z.enum(["PLANNED", "EXTRA"]).default("PLANNED"),
        compliance: z.enum(["ON_PLAN", "OFF_PLAN", "PARTIAL"]).default("ON_PLAN"),
        planId: z.string().optional(),
        planExerciseOrder: z.number().int().optional(),
        notes: z.string().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "delete_client_workout_log",
    desc: "Delete one logged workout entry (use ids from get_client_workout_logs).",
    field: "deleteWorkoutLog",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });
  writeTool(server, {
    name: "upsert_client_daily_metric",
    desc: "Set a client's steps / water glasses / resting HR / active calories / sleep minutes for one day.",
    field: "upsertDailyMetric",
    args: "input: UpsertDailyMetricInput!",
    select: "id clientId date steps glasses restingHeartRate activeCaloriesBurned sleepMinutes",
    shape: {
      input: z.object({
        clientId,
        date: day,
        steps: z.number().int().optional(),
        glasses: z.number().int().optional(),
        restingHeartRate: z.number().int().optional(),
        activeCaloriesBurned: z.number().int().optional(),
        sleepMinutes: z.number().int().optional(),
      }),
    },
  });

  /* ── Clients who don't use the app (managed) + private portal links ── */
  writeTool(server, {
    name: "add_managed_client",
    desc: "Add a client who will not use the app (name + optional WhatsApp number). Counts toward the same client limit as any client.",
    field: "addManagedClient",
    args: "input: AddManagedClientInput!",
    select: "_id name phone isManaged",
    shape: { input: z.object({ name: z.string().min(1), phone: z.string().optional().describe("With country code, e.g. +91 98765 43210") }) },
  });
  writeTool(server, {
    name: "log_managed_client_weight",
    desc: "Record (or replace) a no-app client's weight in kg for a day.",
    field: "logManagedClientWeight",
    args: "clientId: ID!, dateISO: String!, weightKg: Float!",
    select: "dateISO weightKg enteredBy",
    shape: { clientId, dateISO: day, weightKg: z.number().positive() },
  });
  readTool(server, {
    name: "get_managed_client_weights",
    desc: "Weight history for a client the coach added without the app, newest first.",
    field: "managedClientWeights",
    args: "clientId: ID!, limit: Int",
    select: "dateISO weightKg enteredBy",
    shape: { clientId, limit: z.number().int().min(1).max(365).default(60) },
  });
  readTool(server, {
    name: "get_managed_client_activity",
    desc: "For every no-app client with a private link: links live, views, when last opened and last self-logged.",
    field: "managedClientActivity",
    select: "clientId activeLinks totalViews linkSentAt lastOpenedAt lastLoggedAt",
  });
  readTool(server, {
    name: "get_client_portal_info",
    desc: "How many private links are live for a client and how often they were opened.",
    field: "clientPortalInfo",
    args: "clientId: ID!",
    select: "activeLinks totalViews lastViewedAt",
    shape: { clientId },
  });
  writeTool(server, {
    name: "create_client_portal_link",
    desc: "Create a private no-login link for a client (check-ins, plans, receipts, sessions) to send over WhatsApp. The URL is shown once.",
    field: "createClientPortalLink",
    args: "clientId: ID!, expiresInDays: Int",
    select: "url expiresAt plansIncluded",
    shape: { clientId, expiresInDays: z.number().int().min(1).max(365).optional() },
  });
  writeTool(server, {
    name: "revoke_client_portal_links",
    desc: "Turn off every live private link for a client. Returns how many were live.",
    field: "revokeClientPortalLinks",
    args: "clientId: ID!",
    shape: { clientId },
    destructive: true,
  });

  /* ── Contact details ── */
  readTool(server, {
    name: "get_client_contact_details",
    desc: "A client's name, email, phone and date of birth.",
    field: "clientContactDetails",
    args: "clientId: ID!",
    select: "name avatarUrl email phone dateOfBirth isManaged",
    shape: { clientId },
  });
  writeTool(server, {
    name: "update_client_contact_details",
    desc: "Correct a client's name, phone or date of birth. Omit a field to leave it; pass an empty string to clear phone/dateOfBirth.",
    field: "updateClientContactDetails",
    args: "clientId: ID!, name: String, phone: String, dateOfBirth: String",
    select: "name phone dateOfBirth",
    shape: { clientId, name: z.string().optional(), phone: z.string().optional(), dateOfBirth: z.string().optional() },
  });

  /* ── Health reports (smart scale / InBody / DEXA / blood tests) ── */
  readTool(server, {
    name: "list_client_health_reports",
    desc: "Health reports uploaded for a client (body-composition scans, blood tests) with extraction status and the extracted values.",
    field: "healthReportsForClient",
    args: "clientId: ID!",
    select: `_id originalFilename status extractionError projectedProgressEntryId createdAt fileUrl
      extracted { reportDateISO weightKg bodyFatPct leanMassKg muscleMassKg visceralFatRating bmr bodyWaterPct waistCm hipCm chestCm
        bloodMarkers { name value unit referenceRangeLow referenceRangeHigh flag } overallConfidence notes }`,
    shape: { clientId },
  });
  writeTool(server, {
    name: "accept_health_report_into_progress",
    desc: "Promote a NEEDS_REVIEW health report's extracted values into the client's progress timeline.",
    field: "acceptHealthReportIntoProgress",
    args: "reportId: ID!",
    select: "_id status projectedProgressEntryId",
    shape: { reportId: id },
  });
  writeTool(server, {
    name: "delete_health_report",
    desc: "Delete a client's health report.",
    field: "deleteHealthReport",
    args: "reportId: ID!",
    shape: { reportId: id },
    destructive: true,
  });

  /* ── Intake forms ── */
  readTool(server, {
    name: "get_client_intake_form",
    desc: "The intake questionnaire new clients fill in (the coach's own, or the gym's when organizationId is given), with whether it's published and editable.",
    field: "clientIntakeFormSettings",
    args: "organizationId: ID",
    select: `ownerType canEdit requiresUpgrade managedByGym
      form { _id isPublished version hiddenDefaultSections steps { id title description questions { id type label helpText required options } } }`,
    shape: { organizationId: id.optional() },
  });
  readTool(server, {
    name: "get_client_intake_responses",
    desc: "A client's answers to the intake questionnaire.",
    field: "clientIntakeResponses",
    args: "clientId: ID!",
    select: "_id formId formVersion submittedAt updatedAt answers { questionId value values } steps { id title questions { id label type } }",
    shape: { clientId },
  });
  readTool(server, {
    name: "list_clients_pending_intake",
    desc: "Clients who were assigned the intake form but haven't submitted it.",
    field: "clientsWithPendingIntake",
    args: "organizationId: ID",
    select: "clientId startedAt client { _id name email }",
    shape: { organizationId: id.optional() },
  });
  writeTool(server, {
    name: "save_client_intake_form",
    desc: "Create or replace the intake questionnaire (coach's own, or the gym's with organizationId). Replaces all steps; fetch get_client_intake_form first and edit that.",
    field: "saveClientIntakeForm",
    args: "organizationId: ID, input: ClientIntakeFormInput!",
    select: "_id isPublished version",
    shape: {
      organizationId: id.optional(),
      input: z.object({
        isPublished: z.boolean(),
        hiddenDefaultSections: z.array(z.enum(["GOALS", "HEALTH", "PREFERENCES"])).optional(),
        steps: z.array(
          z.object({
            id: z.string().optional(),
            title: z.string().min(1),
            description: z.string().optional(),
            questions: z.array(
              z.object({
                id: z.string().optional(),
                type: z.enum(["SHORT_TEXT", "LONG_TEXT", "NUMBER", "SINGLE_CHOICE", "MULTI_CHOICE", "YES_NO", "DATE", "PHOTO", "AGREEMENT"]),
                label: z.string().min(1),
                helpText: z.string().optional(),
                required: z.boolean().optional(),
                options: z.array(z.string()).optional(),
              })
            ),
          })
        ),
      }),
    },
  });
}
