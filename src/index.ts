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

/* ───────────────────────── Registration ───────────────────────── */

export function registerAll(server: McpServer): void {

/* ───────────────────────── Read tools ───────────────────────── */

server.tool(
  "whoami",
  "Return the authenticated coach (user id, name, email, role) and trainer id. Use to verify the connection.",
  async () =>
    guard(() =>
      gql(`query { user { _id name email role } trainer { userId } }`)
    )
);

server.tool(
  "list_clients",
  "List the coach's clients (id, name, email). Use the returned _id as clientId/userId for other tools.",
  { pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
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
  "list_client_habits",
  "List a client's active habits with today's log and streaks. Pass the client's user _id as clientId.",
  { clientId: z.string().min(1) },
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
  async ({ strategy, calories, weightKg, proteinPerKg, fatPerKg }) =>
    ok(calculateMacros(strategy, calories, weightKg, proteinPerKg, fatPerKg))
);

server.tool(
  "calc_1rm",
  "Estimate a 1-rep max (Epley) and %1RM weight suggestions from a working set.",
  { weightKg: z.number().positive(), reps: z.number().int().positive() },
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
  "list_checkins",
  "List check-ins for the coach (optionally filtered to one client by user _id).",
  { clientId: z.string().min(1).optional() },
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
  "list_sessions",
  "List sessions — for one client (pass clientId) or all of the coach's clients.",
  { clientId: z.string().min(1).optional() },
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
  "Create a workout plan for a client (confirm-gated). exercises: array of { name, sets, reps, restSeconds?, section? }. " +
    "section must be one of WARMUP | RESISTANCE | STRETCHING | CARDIO | COOL_DOWN (defaults to RESISTANCE so the app renders them under 'Main Workout'). " +
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
  "Create a diet plan for a client (confirm-gated). meals: array of MealInput objects (e.g. { name, slot, calories, macros, days }).",
  {
    clientId: z.string().min(1),
    title: z.string().min(1),
    startDate: z.string().min(1).describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    meals: z.array(z.record(z.unknown())).min(1),
    ...confirmField,
  },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("create_diet_plan", args);
    return guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `mutation CD($input: CreateDietPlanInput!) { createDietPlan(input: $input) { _id title } }`,
        { input: { trainerId, ...args } }
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
