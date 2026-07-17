#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { assertConfigured } from "./config.js";
import { gql } from "./client.js";
import {
  calculateMacros,
  computeBmr,
  computeOneRm,
  computeTdee,
  recommendedCalories,
  weightSuggestions,
} from "./calc.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

async function trainerUserId(): Promise<string> {
  const data = await gql<{ trainer?: { userId?: string } }>(`query { trainer { userId } }`);
  const id = data.trainer?.userId;
  if (!id) throw new Error("Could not resolve trainer id for the authenticated user.");
  return id;
}

const WORKOUT_SECTIONS = ["WARMUP", "RESISTANCE", "STRETCHING", "CARDIO", "COOL_DOWN"];
const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
const READ_ONLY = { readOnlyHint: true } as const;

/** Coerce loose exercise objects into valid ExerciseInput: known section + required numeric fields. */
function normalizeExercises(exercises: Record<string, unknown>[]): Record<string, unknown>[] {
  return exercises.map((raw, i) => {
    const e: Record<string, unknown> = { ...raw };
    const sec = String(e.section ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    e.section = WORKOUT_SECTIONS.includes(sec) ? sec : "RESISTANCE";
    e.name = String(e.name ?? "Exercise");
    e.sets = Number(e.sets) > 0 ? Number(e.sets) : 3;
    e.reps = Number(e.reps) > 0 ? Number(e.reps) : 10;
    e.restSeconds = Number(e.restSeconds) >= 0 ? Number(e.restSeconds) : 60;
    e.order = Number(e.order) > 0 ? Number(e.order) : i + 1;
    return e;
  });
}

const DIET_SECTION_DEFAULTS = new Map<string, { section?: string; scheduledTime: string }>([
  ["BREAKFAST", { section: "BREAKFAST", scheduledTime: "08:00" }],
  ["MORNING_SNACK", { section: "MID_MORNING_SNACKS", scheduledTime: "11:00" }],
  ["MID_MORNING_SNACK", { section: "MID_MORNING_SNACKS", scheduledTime: "11:00" }],
  ["MID_MORNING_SNACKS", { section: "MID_MORNING_SNACKS", scheduledTime: "11:00" }],
  ["LUNCH", { section: "LUNCH", scheduledTime: "13:00" }],
  ["AFTERNOON_SNACK", { section: "EVENING_SNACKS", scheduledTime: "17:00" }],
  ["EVENING_SNACK", { section: "EVENING_SNACKS", scheduledTime: "17:00" }],
  ["EVENING_SNACKS", { section: "EVENING_SNACKS", scheduledTime: "17:00" }],
  ["SNACK", { section: "EVENING_SNACKS", scheduledTime: "17:00" }],
  ["DINNER", { section: "DINNER", scheduledTime: "20:00" }],
  ["BEDTIME_SNACK", { section: "BEDTIME_SNACKS", scheduledTime: "22:00" }],
  ["BEDTIME_SNACKS", { section: "BEDTIME_SNACKS", scheduledTime: "22:00" }],
  ["OTHER", { section: "OTHER_SUPPLEMENTS", scheduledTime: "16:00" }],
  ["SUPPLEMENT", { section: "OTHER_SUPPLEMENTS", scheduledTime: "16:00" }],
  ["SUPPLEMENTS", { section: "OTHER_SUPPLEMENTS", scheduledTime: "16:00" }],
  ["OTHER_SUPPLEMENTS", { section: "OTHER_SUPPLEMENTS", scheduledTime: "16:00" }],
  ["PRE_WORKOUT", { section: "OTHER_SUPPLEMENTS", scheduledTime: "16:00" }],
  ["POST_WORKOUT", { section: "OTHER_SUPPLEMENTS", scheduledTime: "18:00" }],
]);

const dietMealSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    calories: z.number().positive().optional(),
    macros: z
      .object({
        protein: z.number().optional(),
        carbs: z.number().optional(),
        fat: z.number().optional(),
        fiber: z.number().optional(),
        sugar: z.number().optional(),
        sodiumMg: z.number().optional(),
        cholesterolMg: z.number().optional(),
        alcoholG: z.number().optional(),
        portionSizeG: z.number().optional(),
      })
      .optional(),
    scheduledTime: z.string().optional().describe("Preferred format HH:mm"),
    order: z.number().int().positive().optional(),
    section: z.string().optional(),
    slot: z.string().optional().describe("Legacy alias: BREAKFAST, LUNCH, DINNER, SNACK, etc."),
    days: z.array(z.string()).optional().describe("[MONDAY..SUNDAY], defaults to every day"),
    recipeUrl: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .passthrough();

function normalizeDietKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeMealDays(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...WEEKDAYS];
  }

  const normalized = value
    .map((day) => normalizeDietKey(day))
    .filter((day): day is (typeof WEEKDAYS)[number] => WEEKDAYS.includes(day as (typeof WEEKDAYS)[number]));

  return normalized.length ? normalized : [...WEEKDAYS];
}

function normalizeMealMacros(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const protein = normalizeOptionalNumber(record.protein);
  const carbs = normalizeOptionalNumber(record.carbs);
  const fat = normalizeOptionalNumber(record.fat);
  if (protein == null || carbs == null || fat == null) {
    return undefined;
  }

  const normalized: Record<string, number> = { protein, carbs, fat };
  for (const key of ["fiber", "sugar", "sodiumMg", "cholesterolMg", "alcoholG", "portionSizeG"] as const) {
    const numeric = normalizeOptionalNumber(record[key]);
    if (numeric != null) {
      normalized[key] = numeric;
    }
  }

  return normalized;
}

function normalizeDietMeals(meals: Record<string, unknown>[]): Record<string, unknown>[] {
  return meals.map((raw, index) => {
    const legacyKey = normalizeDietKey(raw.slot ?? raw.section);
    const defaults = DIET_SECTION_DEFAULTS.get(legacyKey);
    const scheduledTime = normalizeOptionalString(raw.scheduledTime) ?? defaults?.scheduledTime ?? "12:00";
    const section = normalizeOptionalString(raw.section) ?? defaults?.section;

    const normalized: Record<string, unknown> = {
      name: normalizeOptionalString(raw.name) ?? `Meal ${index + 1}`,
      scheduledTime,
      order: Number(raw.order) > 0 ? Number(raw.order) : index + 1,
      days: normalizeMealDays(raw.days),
    };

    if (section) normalized.section = section;

    const description = normalizeOptionalString(raw.description);
    if (description) normalized.description = description;

    const calories = normalizeOptionalNumber(raw.calories);
    if (calories != null) normalized.calories = calories;

    const macros = normalizeMealMacros(raw.macros);
    if (macros) normalized.macros = macros;

    const recipeUrl = normalizeOptionalString(raw.recipeUrl);
    if (recipeUrl) normalized.recipeUrl = recipeUrl;

    const avatarUrl = normalizeOptionalString(raw.avatarUrl);
    if (avatarUrl) normalized.avatarUrl = avatarUrl;

    return normalized;
  });
}

/* ───────────────────────── Registration ───────────────────────── */

export function registerAll(server: McpServer): void {

/* ───────────────────────── Read tools ───────────────────────── */

server.tool(
  "whoami",
  "Return the authenticated coach (user id, name, email, role) and trainer id. Use to verify the connection.",
  READ_ONLY,
  async () =>
    guard(() =>
      gql(`query { user { _id name email role } trainer { userId } }`)
    )
);

server.tool(
  "list_clients",
  "List the coach's clients (id, name, email). Use the returned _id as clientId/userId for other tools.",
  { pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  READ_ONLY,
  async ({ pageNumber, pageSize }) =>
    guard(() =>
      gql(
        `query Clients($pageNumber: Int!, $pageSize: Int!) {
           clients(pagination: { pageNumber: $pageNumber, pageSize: $pageSize }) {
             _id name email avatarUrl
           }
         }`,
        { pageNumber, pageSize }
      )
    )
);

server.tool(
  "get_client_profile",
  "Get a client's fitness profile + computed metrics (BMI, TDEE, recommended calories). Pass the client's user _id.",
  { userId: z.string().min(1) },
  READ_ONLY,
  async ({ userId }) =>
    guard(() =>
      gql(
        `query Profile($userId: ID!) {
           fitnessProfile(userId: $userId) {
             userId
             profile {
               name age gender heightCm currentWeightKg targetWeightKg goal activityLevel
               computed { bmi bmiCategory tdee recommendedCaloriesPerDay }
             }
           }
         }`,
        { userId }
      )
    )
);

server.tool(
  "search_exercises",
  "Search the exercise catalog by free-text name (e.g. 'barbell squat'). Returns real catalog exercises with an id. " +
    "Call this for each exercise before create_workout_plan and, when there's one confident match, use its exact id " +
    "as that exercise's exerciseId and its name as the exercise name — the app resolves the image/video from exerciseId " +
    "automatically, so a matched exerciseId is what makes the exercise show media in the app. If nothing confidently " +
    "matches, fall back to a plain name with no exerciseId.",
  { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) },
  READ_ONLY,
  async ({ query, limit }) =>
    guard(() =>
      gql(
        `query SearchExercises($query: String!, $limit: Int) {
           searchExercises(query: $query, limit: $limit) {
             id name bodyPart target equipment
             previewImage { url }
           }
         }`,
        { query, limit }
      )
    )
);

server.tool(
  "list_client_habits",
  "List a client's active habits with today's log and streaks. Pass the client's user _id as clientId.",
  { clientId: z.string().min(1) },
  READ_ONLY,
  async ({ clientId }) =>
    guard(() =>
      gql(
        `query Habits($clientId: ID!) {
           getHabitsForClient(clientId: $clientId) {
             _id name emoji category frequency targetCount currentStreak longestStreak
             todayLog { completedCount }
           }
         }`,
        { clientId }
      )
    )
);

server.tool(
  "get_habit_compliance",
  "Habit compliance percentage (0-100) for a client over a date range (YYYY-MM-DD).",
  {
    clientId: z.string().min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  },
  READ_ONLY,
  async ({ clientId, startDate, endDate }) =>
    guard(() =>
      gql(
        `query Compliance($clientId: ID!, $startDate: String!, $endDate: String!) {
           getHabitComplianceForCoach(clientId: $clientId, startDate: $startDate, endDate: $endDate)
         }`,
        { clientId, startDate, endDate }
      )
    )
);

server.tool(
  "recent_habit_activity",
  "Recent habit completions across all of the coach's clients (newest first).",
  { limit: z.number().int().min(1).max(100).default(20) },
  READ_ONLY,
  async ({ limit }) =>
    guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `query Activity($trainerId: ID!, $limit: Int) {
           recentHabitActivityForTrainer(trainerId: $trainerId, limit: $limit) {
             habitName habitEmoji clientName date completedCount
           }
         }`,
        { trainerId, limit }
      );
    })
);

server.tool(
  "master_habits",
  "List the coach's reusable Master Habit library.",
  READ_ONLY,
  async () =>
    guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `query Master($trainerId: ID!) {
           masterHabitsForTrainer(trainerId: $trainerId) {
             _id name emoji category frequency targetCount
           }
         }`,
        { trainerId }
      );
    })
);

/* ───────────────────────── Calculators (offline) ───────────────────────── */

server.tool(
  "calc_tdee",
  "Compute BMR, TDEE, and recommended daily calories from client stats.",
  {
    gender: z.enum(["MALE", "FEMALE"]),
    weightKg: z.number().positive(),
    heightCm: z.number().positive(),
    age: z.number().int().positive(),
    activity: z.enum(["SEDENTARY", "LIGHT", "MODERATE", "ACTIVE", "VERY_ACTIVE"]).default("MODERATE"),
    goal: z.enum(["LOSE_FAT", "MAINTAIN", "GAIN_MUSCLE"]).default("MAINTAIN"),
    bodyFatPct: z.number().min(0).max(70).optional(),
  },
  READ_ONLY,
  async ({ gender, weightKg, heightCm, age, activity, goal, bodyFatPct }) => {
    const bmr = computeBmr(gender, weightKg, heightCm, age, bodyFatPct);
    const tdee = computeTdee(bmr, activity);
    return ok({ bmr, tdee, recommendedCaloriesPerDay: recommendedCalories(goal, tdee) });
  }
);

server.tool(
  "calc_macros",
  "Compute a macro split (protein/carbs/fat in grams) for a strategy. STANDARD=40/30/30, PRO=g/kg multipliers, KETO=25/5/70.",
  {
    strategy: z.enum(["STANDARD", "PRO", "KETO"]).default("STANDARD"),
    calories: z.number().positive(),
    weightKg: z.number().positive(),
    proteinPerKg: z.number().positive().optional(),
    fatPerKg: z.number().positive().optional(),
  },
  READ_ONLY,
  async ({ strategy, calories, weightKg, proteinPerKg, fatPerKg }) =>
    ok(calculateMacros(strategy, calories, weightKg, proteinPerKg, fatPerKg))
);

server.tool(
  "calc_1rm",
  "Estimate a 1-rep max (Epley) and %1RM weight suggestions from a working set.",
  { weightKg: z.number().positive(), reps: z.number().int().positive() },
  READ_ONLY,
  async ({ weightKg, reps }) => {
    const oneRm = computeOneRm(weightKg, reps);
    return ok({ oneRepMaxKg: oneRm, suggestions: weightSuggestions(oneRm) });
  }
);

/* ───────────────────────── More reads: plans / check-ins / sessions / billing ───────────────────────── */

const PAGE = { pageNumber: 1, pageSize: 50 };

server.tool(
  "list_workout_plans",
  "List a client's workout plans (id, title, dates). Pass the client's user _id.",
  { clientId: z.string().min(1) },
  READ_ONLY,
  async ({ clientId }) =>
    guard(() =>
      gql(
        `query WP($clientId: ID!, $p: PaginationInput!) {
           workoutPlansForClient(clientId: $clientId, pagination: $p) { _id title startDate endDate createdAt }
         }`,
        { clientId, p: PAGE }
      )
    )
);

server.tool(
  "list_diet_plans",
  "List a client's diet plans (id, title, dates). Pass the client's user _id.",
  { clientId: z.string().min(1) },
  READ_ONLY,
  async ({ clientId }) =>
    guard(() =>
      gql(
        `query DP($clientId: ID!, $p: PaginationInput!) {
           dietPlansForClient(clientId: $clientId, pagination: $p) { _id title startDate endDate createdAt }
         }`,
        { clientId, p: PAGE }
      )
    )
);

server.tool(
  "get_client_ai_history",
  "Check this client's past AI Coach runs before building or adjusting their plan. If a past run's status is 'failed', its error field is the coach's rejection reason — treat that as a hard constraint and don't repeat whatever it flagged. Call this before create_workout_plan/create_diet_plan.",
  { clientId: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
  READ_ONLY,
  async ({ clientId, limit }) =>
    guard(() =>
      gql(
        `query ClientAIHistory($clientId: ID!, $limit: Int) {
           aiRunHistoryForClient(clientId: $clientId, limit: $limit) {
             _id type status error reviewedAt createdAt retryOfRunId
           }
         }`,
        { clientId, limit }
      )
    )
);

server.tool(
  "list_checkins",
  "List check-ins for the coach (optionally filtered to one client by user _id).",
  { clientId: z.string().min(1).optional() },
  READ_ONLY,
  async ({ clientId }) =>
    guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `query CI($trainerId: ID!, $clientId: ID) {
           checkInsForTrainer(trainerId: $trainerId, clientId: $clientId) { _id clientId scheduledFor }
         }`,
        { trainerId, clientId: clientId ?? null }
      );
    })
);

server.tool(
  "get_checkin_answers",
  "Get a check-in's questions + latest answers. PHOTO-type answers are resolved to fetchable image URLs — pass those into get_client_images to actually view them.",
  { checkInId: z.string().min(1) },
  READ_ONLY,
  async ({ checkInId }) =>
    guard(() =>
      gql(
        `query CheckInAnswers($checkInId: ID!) {
           checkIn: checkInById(id: $checkInId) { _id clientId scheduledFor questions { id type label required } }
           logs: checkInLogs(checkInId: $checkInId) { answers { questionId value } createdAt }
           photoAnswers: checkInPhotoAnswers(checkInId: $checkInId) { questionId label imageUrl }
         }`,
        { checkInId }
      )
    )
);

server.tool(
  "get_client_images",
  "Fetch check-in photo(s) and return base64-encoded image data for visual analysis. Pass imageUrl(s) from get_checkin_answers's photoAnswers.",
  { imageUrls: z.array(z.string().min(1)).min(1).max(10) },
  READ_ONLY,
  async ({ imageUrls }) =>
    guard(async () => {
      const results = await Promise.all(
        imageUrls.map(async (imageUrl) => {
          try {
            const res = await fetch(imageUrl);
            if (!res.ok) {
              return { imageUrl, error: `HTTP ${res.status}` };
            }
            const contentType = res.headers.get("content-type") ?? "application/octet-stream";
            const buffer = Buffer.from(await res.arrayBuffer());
            return { imageUrl, contentType, base64: buffer.toString("base64") };
          } catch (e) {
            return { imageUrl, error: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      return { images: results };
    })
);

server.tool(
  "list_sessions",
  "List sessions — for one client (pass clientId) or all of the coach's clients.",
  { clientId: z.string().min(1).optional() },
  READ_ONLY,
  async ({ clientId }) =>
    guard(async () => {
      if (clientId) {
        return gql(
          `query S($clientId: ID!, $p: PaginationInput!) {
             sessionsForClient(clientId: $clientId, pagination: $p) { _id clientId type status scheduledStart scheduledEnd }
           }`,
          { clientId, p: PAGE }
        );
      }
      const trainerId = await trainerUserId();
      return gql(
        `query S($trainerId: ID!, $p: PaginationInput!) {
           sessionsForTrainer(trainerId: $trainerId, pagination: $p) { _id clientId type status scheduledStart scheduledEnd }
         }`,
        { trainerId, p: PAGE }
      );
    })
);

server.tool(
  "list_subscriptions",
  "List the coach's client subscriptions (id, subscriber = client id, status). Use a subscription _id when scheduling a session.",
  READ_ONLY,
  async () =>
    guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `query Subs($trainerId: ID!) {
           subscriptionsForTrainer(trainerId: $trainerId) { _id subscriber status }
         }`,
        { trainerId }
      );
    })
);

server.tool(
  "billing_summary",
  "Summarise the coach's payments: total captured amount (minor units), currency, and counts by status.",
  READ_ONLY,
  async () =>
    guard(async () => {
      const trainerId = await trainerUserId();
      const data = await gql<{ paymentsForTrainer: { amount: number; currency: string; status: string }[] }>(
        `query Pay($trainerId: ID!) {
           paymentsForTrainer(trainerId: $trainerId) { _id amount currency status }
         }`,
        { trainerId }
      );
      const payments = data.paymentsForTrainer ?? [];
      const byStatus: Record<string, number> = {};
      let capturedMinor = 0;
      let currency = "";
      for (const p of payments) {
        byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
        if (p.status?.toUpperCase() === "CAPTURED") capturedMinor += p.amount || 0;
        if (!currency && p.currency) currency = p.currency;
      }
      return { totalPayments: payments.length, capturedMinorUnits: capturedMinor, currency, countsByStatus: byStatus };
    })
);

/* ───────────────────────── Write tools (confirm-gated) ───────────────────────── */

const confirmField = {
  confirm: z
    .boolean()
    .default(false)
    .describe("Must be true to actually execute. If false/omitted, returns a preview only."),
};

function preview(action: string, details: unknown): ToolResult {
  return ok({ status: "preview", action, details, note: "Re-run the tool with confirm: true to execute." });
}

const CATEGORY = z.enum(["ACTIVITY", "NUTRITION", "MINDFULNESS", "SLEEP", "HYDRATION", "OTHER"]);
const FREQUENCY = z.enum(["DAILY", "WEEKLY"]);

server.tool(
  "create_habit",
  "Create a habit for a client (confirm-gated). daysOfWeek: 0=Sun..6=Sat (empty = every day). reminderTime: 'HH:mm'.",
  {
    clientId: z.string().min(1),
    name: z.string().min(1),
    emoji: z.string().optional(),
    description: z.string().optional(),
    category: CATEGORY.optional(),
    frequency: FREQUENCY.default("DAILY"),
    targetCount: z.number().int().min(1).default(1),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    reminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("create_habit", input);
    return guard(() =>
      gql(`mutation C($input: CreateHabitInput!) { createHabit(input: $input) { _id name } }`, { input })
    );
  }
);

server.tool(
  "create_master_habit",
  "Create a reusable Master Habit in the coach's library (confirm-gated).",
  {
    name: z.string().min(1),
    emoji: z.string().optional(),
    description: z.string().optional(),
    category: CATEGORY.optional(),
    frequency: FREQUENCY.default("DAILY"),
    targetCount: z.number().int().min(1).default(1),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("create_master_habit", input);
    return guard(() =>
      gql(`mutation C($input: CreateMasterHabitInput!) { createMasterHabit(input: $input) { _id name } }`, { input })
    );
  }
);

server.tool(
  "assign_master_habit",
  "Assign a Master Habit to one or more clients — creates a habit per client (confirm-gated).",
  { masterHabitId: z.string().min(1), clientIds: z.array(z.string().min(1)).min(1), ...confirmField },
  async ({ confirm, masterHabitId, clientIds }) => {
    if (!confirm) return preview("assign_master_habit", { masterHabitId, clientIds });
    return guard(() =>
      gql(
        `mutation A($masterHabitId: ID!, $clientIds: [ID!]!) {
           assignMasterHabitToClients(masterHabitId: $masterHabitId, clientIds: $clientIds) { _id clientId }
         }`,
        { masterHabitId, clientIds }
      )
    );
  }
);

server.tool(
  "create_checkin",
  "Schedule a check-in for a client with optional questions (confirm-gated). scheduledFor: ISO date. question.type: TEXT|NUMBER|SCALE|PHOTO.",
  {
    clientId: z.string().min(1),
    scheduledFor: z.string().min(1).describe("ISO date/time, e.g. 2026-06-10 or 2026-06-10T09:00:00Z"),
    questions: z
      .array(
        z.object({
          type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO"]),
          label: z.string().min(1),
          required: z.boolean().optional(),
        })
      )
      .optional(),
    ...confirmField,
  },
  async ({ confirm, clientId, scheduledFor, questions }) => {
    if (!confirm) return preview("create_checkin", { clientId, scheduledFor, questions });
    return guard(async () => {
      const trainerId = await trainerUserId();
      const normalizedQuestions = (questions ?? []).map((q) => ({
        ...q,
        id: crypto.randomUUID(),
      }));
      return gql(
        `mutation CC($input: CreateCheckInInput!) { createCheckIn(input: $input) { _id scheduledFor } }`,
        { input: { trainerId, clientId, scheduledFor, questions: normalizedQuestions } }
      );
    });
  }
);

server.tool(
  "schedule_session",
  "Book a session for a client (confirm-gated). Needs the client's subscriptionId (see list_subscriptions). Times are ISO strings.",
  {
    clientId: z.string().min(1),
    subscriptionId: z.string().min(1),
    type: z.enum(["IN_PERSON", "ONLINE"]).default("ONLINE"),
    scheduledStart: z.string().min(1),
    scheduledEnd: z.string().min(1),
    meetingLink: z.string().url().optional(),
    ...confirmField,
  },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("schedule_session", args);
    return guard(async () => {
      const trainerId = await trainerUserId();
      const input = { trainerId, ...args };
      return gql(
        `mutation B($input: BookSessionInput!) {
           bookSession(input: $input) { _id type status scheduledStart scheduledEnd }
         }`,
        { input }
      );
    });
  }
);

server.tool(
  "create_workout_plan",
  "Create a workout plan for a client (confirm-gated). exercises: array of { name, sets, reps, restSeconds?, section?, exerciseId?, notes? }. " +
    "section must be one of WARMUP | RESISTANCE | STRETCHING | CARDIO | COOL_DOWN (defaults to RESISTANCE so the app renders them under 'Main Workout'). " +
    "exerciseId: pass the id from search_exercises when there's a confident catalog match — this is what makes the exercise show an image/video to the client. " +
    "notes: one short sentence explaining why this exercise is in the plan — shown to the client under the exercise. " +
    "days: optional [MONDAY..SUNDAY].",
  {
    clientId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    startDate: z.string().min(1).describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    exercises: z.array(z.record(z.unknown())).min(1),
    days: z.array(z.string()).optional(),
    ...confirmField,
  },
  async ({ confirm, exercises, ...args }) => {
    const normalized = normalizeExercises(exercises);
    if (!confirm) return preview("create_workout_plan", { ...args, exercises: normalized });
    return guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `mutation CW($input: CreateWorkoutPlanInput!) { createWorkoutPlan(input: $input) { _id title } }`,
        { input: { trainerId, ...args, exercises: normalized } }
      );
    });
  }
);

server.tool(
  "create_diet_plan",
  "Create a diet plan for a client (confirm-gated). Prefer meals like { name, scheduledTime: 'HH:mm', order, days: [MONDAY..SUNDAY], section, calories, macros, description }. " +
    "description: one short sentence explaining why this meal is included — shown to the client under the meal. " +
    "Legacy slot values like BREAKFAST/LUNCH/DINNER/SNACK are accepted and auto-mapped.",
  {
    clientId: z.string().min(1),
    title: z.string().min(1),
    startDate: z.string().min(1).describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    meals: z.array(dietMealSchema).min(1),
    ...confirmField,
  },
  async ({ confirm, meals, ...args }) => {
    const normalizedMeals = normalizeDietMeals(meals as Record<string, unknown>[]);
    if (!confirm) return preview("create_diet_plan", { ...args, meals: normalizedMeals });
    return guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `mutation CD($input: CreateDietPlanInput!) { createDietPlan(input: $input) { _id title } }`,
        { input: { trainerId, ...args, meals: normalizedMeals } }
      );
    });
  }
);

/* ───────────────────────── Resource: client profile ───────────────────────── */

server.resource(
  "client-profile",
  new ResourceTemplate("tzilla://client/{clientId}/profile", { list: undefined }),
  { description: "A client's fitness profile + computed metrics as a readable resource." },
  async (uri, { clientId }) => {
    const data = await gql(
      `query P($userId: ID!) {
         fitnessProfile(userId: $userId) {
           userId
           profile { name age gender heightCm currentWeightKg targetWeightKg goal activityLevel
             computed { bmi bmiCategory tdee recommendedCaloriesPerDay } }
         }
       }`,
      { userId: String(clientId) }
    );
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  }
);

/* ───────────────────────── Prompt: weekly client review ───────────────────────── */

server.prompt(
  "weekly_client_review",
  "Prepare a weekly review for a client: pull profile, habits, compliance, recent activity, sessions and summarise wins, risks, and next actions.",
  { clientId: z.string().min(1).describe("The client's user _id (from list_clients)") },
  ({ clientId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Prepare this week's coaching review for client ${clientId}.\n\n` +
            `Use the tzilla-coach tools:\n` +
            `1. get_client_profile(userId: "${clientId}")\n` +
            `2. list_client_habits(clientId: "${clientId}") and get_habit_compliance for the last 7 days\n` +
            `3. recent_habit_activity and list_sessions(clientId: "${clientId}")\n\n` +
            `Then write a concise review: progress vs. goal, habit wins, at-risk/missed habits, ` +
            `upcoming sessions, and 2-3 specific recommended actions for next week. ` +
            `Do not create or change anything — this is read-only analysis.`,
        },
      },
    ],
  })
);

} /* end registerAll */

/** Build a fully-registered MCP server instance. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "tzilla-coach", version: "0.1.0" });
  registerAll(server);
  return server;
}

/* ───────────────────────── Boot (stdio) ───────────────────────── */

async function main() {
  assertConfigured();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  console.error("tzilla-coach MCP server running (stdio).");
}

// Only boot stdio when run directly (so http.ts can import buildServer without side effects).
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((e) => {
    console.error("Fatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
