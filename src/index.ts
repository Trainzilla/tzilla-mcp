#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { assertConfigured } from "./config.js";
import { gql } from "./client.js";
import { pickRecentDuplicate, RecentPlan } from "./duplicate-guard.js";
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
const MODALITIES = ["STRENGTH", "INTERVAL", "STEADY", "AMRAP", "EMOM", "FOR_TIME", "HOLD"];
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

    // Off-strength prescriptions: a run is distance and pace, an AMRAP a time
    // cap. sets/reps above stay populated because the schema requires them,
    // but these carry the real prescription.
    const mod = String(e.modality ?? "").toUpperCase().replace(/[\s-]+/g, "_");
    if (MODALITIES.includes(mod)) e.modality = mod;
    else delete e.modality;
    for (const key of ["rounds", "durationSeconds", "distanceMeters", "recoverySeconds"] as const) {
      const n = Number(e[key]);
      if (Number.isFinite(n) && n > 0) e[key] = n;
      else delete e[key];
    }
    for (const key of ["targetPace", "effort"] as const) {
      const v = String(e[key] ?? "").trim();
      if (v) e[key] = v;
      else delete e[key];
    }
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
    ingredients: z
      .array(
        z
          .object({
            name: z.string().min(1),
            quantity: z.number().positive(),
            unit: z.string().optional().describe("g, ml, piece, tbsp — defaults to g"),
            isCookingAddition: z.boolean().optional().describe("true for oil, ghee, sugar, salt"),
            calories: z.number().optional(),
            protein: z.number().optional(),
            carbs: z.number().optional(),
            fat: z.number().optional(),
          })
          .passthrough(),
      )
      .optional()
      .describe("Raw materials with quantities. Include the cooking fat (oil/ghee) as its own item."),
    recipeUrl: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .passthrough();

// New diet plans must be fully itemised. Without this the model tends to write
// the per-ingredient breakdown as prose in its reply and then send a thin tool
// call (name + calories + macros only), so the saved plan loses every quantity.
const requireItemisedMeals = (meals: unknown[], ctx: z.RefinementCtx) => {
  meals.forEach((meal, i) => {
    const ingredients = (meal as { ingredients?: unknown })?.ingredients;
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, "ingredients"],
        message:
          "Every meal must be itemised: list each raw ingredient with a numeric `quantity` and `unit` " +
          "(and include the cooking oil/ghee/butter as its own ingredient). Do not send a meal with only " +
          "calories/macros — use get_ingredient_nutrition for the numbers and make the ingredients sum to the meal total.",
      });
    }
  });
};

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

    const ingredients = normalizeMealIngredients(raw.ingredients);
    if (ingredients.length) normalized.ingredients = ingredients;

    return normalized;
  });
}

function normalizeMealIngredients(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const name = normalizeOptionalString(item.name);
      const quantity = normalizeOptionalNumber(item.quantity);
      if (!name || quantity == null || quantity <= 0) return null;
      const out: Record<string, unknown> = {
        name,
        quantity,
        unit: normalizeOptionalString(item.unit) ?? "g",
      };
      if (typeof item.isCookingAddition === "boolean") out.isCookingAddition = item.isCookingAddition;
      for (const key of ["calories", "protein", "carbs", "fat"] as const) {
        const n = normalizeOptionalNumber(item[key]);
        if (n != null) out[key] = n;
      }
      return out;
    })
    .filter((x): x is Record<string, unknown> => x != null);
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
  "Get a client's fitness profile + computed metrics (BMI, TDEE, recommended calories, start/latest logged weight). " +
    "Pass `clientId` (the client's user _id, same value every other tool takes). `userId` is accepted as an alias.",
  {
    clientId: z.string().min(1).optional(),
    userId: z.string().min(1).optional(),
  },
  READ_ONLY,
  async ({ clientId, userId }) =>
    guard(() => {
      const id = clientId ?? userId;
      if (!id) throw new Error("get_client_profile requires clientId (the client's user _id).");
      return gql(
        `query Profile($userId: ID!) {
           fitnessProfile(userId: $userId) {
             userId
             profile {
               name age gender heightCm currentWeightKg targetWeightKg goal activityLevel
               startWeightKg latestLoggedWeightKg weightDeltaKgFromStart
               computed { bmi bmiCategory tdee recommendedCaloriesPerDay }
             }
           }
         }`,
        { userId: id }
      );
    })
);

server.tool(
  "search_exercises",
  "Search the exercise catalog by free-text name (e.g. 'barbell squat'). Returns real catalog exercises with an id, " +
    "sorted by matchConfidence (0-1, fraction of your query's words found on that catalog entry). " +
    "Call this for each exercise before create_workout_plan. Use the top result's exact id as that exercise's exerciseId " +
    "and its name as the exercise name only when its matchConfidence is high (roughly 0.7+) — the app resolves the " +
    "image/video from exerciseId automatically, so a matched exerciseId is what makes the exercise show media in the app. " +
    "If every result has low matchConfidence, or there are no results at all, don't guess — fall back to a plain name " +
    "with no exerciseId rather than linking a wrong exercise's image.",
  { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) },
  READ_ONLY,
  async ({ query, limit }) =>
    guard(() =>
      gql(
        `query SearchExercises($query: String!, $limit: Int) {
           searchExercises(query: $query, limit: $limit) {
             id name bodyPart target equipment matchConfidence
             previewImage { url }
           }
         }`,
        { query, limit }
      )
    )
);

server.tool(
  "get_training_split",
  "Named training programme templates (Full-Body, PPL, Upper/Lower, 5x5, powerlifting peaking, HYROX, CrossFit metcon, hybrid athlete, Couch-to-5K, half/marathon, calisthenics, home minimal, senior, prenatal) with their day-by-day structure, who they suit, the progression rule and the cautions. " +
    "Call this BEFORE create_workout_plan so the week is built on a real, named structure instead of one improvised from scratch. " +
    "Search by name ('hyrox', 'ppl', 'couch to 5k') or by goal + daysPerWeek + experience. Each day lists the modalities it should use — build those sessions with matching modality on each exercise, never sets/reps for a run.",
  {
    query: z.string().optional().describe("Programme name, e.g. 'hyrox', 'ppl', 'marathon'"),
    daysPerWeek: z.number().int().min(1).max(7).optional(),
    experience: z.string().optional().describe("BEGINNER | INTERMEDIATE | ADVANCED"),
    goal: z.string().optional().describe("e.g. 'lose fat', 'build muscle', 'endurance'"),
    limit: z.number().int().min(1).max(20).default(5),
  },
  READ_ONLY,
  async ({ query, daysPerWeek, experience, goal, limit }) =>
    guard(() =>
      gql(
        `query TrainingSplits($query: String, $daysPerWeek: Int, $experience: String, $goal: String, $limit: Int) {
           trainingSplits(query: $query, daysPerWeek: $daysPerWeek, experience: $experience, goal: $goal, limit: $limit) {
             key name category daysPerWeek suitsExperience suitsGoals summary
             days { focus summary modalities }
             progression cautions matchConfidence
           }
         }`,
        { query, daysPerWeek, experience, goal, limit }
      )
    )
);

server.tool(
  "get_ingredient_nutrition",
  "Per-100g nutrition (calories, protein, carbs, fat) for raw ingredients, from the platform's curated table. " +
    "Call this while building a diet plan to itemise each meal into real raw materials with real quantities, instead of guessing per-food macros. " +
    "Query by plain name ('paneer', 'cooking oil', 'toor dal'); results are ranked by matchConfidence and include a typicalServingG anchor and an isCookingAddition flag. " +
    "Scale the per-100g figures to your chosen quantity (e.g. 60 g paneer = 60% of the per-100g values). If an ingredient isn't found, estimate sensibly and still list it — never drop the cooking fat.",
  { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
  READ_ONLY,
  async ({ query, limit }) =>
    guard(() =>
      gql(
        `query IngredientNutrition($query: String!, $limit: Int) {
           ingredientNutrition(query: $query, limit: $limit) {
             name category caloriesPer100g proteinPer100g carbsPer100g fatPer100g
             isCookingAddition typicalServingG matchConfidence
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
    gender: z.enum(["MALE", "FEMALE", "OTHER"]),
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
  "get_client_preferences",
  "The client's own stated constraints — diet type, food allergies, cuisines, meals per day, cooking level, which days they can train, home vs gym, what equipment they actually have, preferred time and session length, plus free-text notes. " +
    "These are hard constraints, not suggestions: a diet plan that violates dietType, foodAllergies or mealsPerDay is rejected outright by the server, and a workout plan built for equipment they don't own is unusable. " +
    "Call this BEFORE create_workout_plan/create_diet_plan on every run, including weekly adjustments — clients change these between runs, and the previous plan does not tell you what they say today. Returns null if they have not set any.",
  { clientId: z.string().min(1) },
  READ_ONLY,
  async ({ clientId }) =>
    guard(() =>
      gql(
        `query ClientPreferences($userId: ID!) {
           aiCoachPreferencesForUser(userId: $userId) {
             dietType foodAllergies cuisinePreferences mealsPerDay cookingLevel
             availableWorkoutDays workoutLocation availableEquipment
             preferredWorkoutTime workoutDurationMins
             exerciseNotes dietNotes updatedAt
           }
         }`,
        { userId: clientId }
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
  "get_platform_rejection_trends",
  "Check what coaches across the whole platform have been rejecting recently, as category counts (never any client's raw rejection text — this is a general pattern, not client-specific data). " +
    "Use this as a secondary caution alongside get_client_ai_history, not a hard constraint: if one category is clearly dominant (e.g. over 30% of recent rejections), be a bit more conservative in that area by default, unless this client's own profile or history argues otherwise. This client's own data always takes priority over this platform-wide signal.",
  { sinceDays: z.number().int().min(1).max(90).default(30) },
  READ_ONLY,
  async ({ sinceDays }) =>
    guard(() =>
      gql(
        `query PlatformRejectionTrends($sinceDays: Int) {
           aiRejectionTrends(sinceDays: $sinceDays) {
             category count percentage
           }
         }`,
        { sinceDays }
      )
    )
);

server.tool(
  "get_recovery_signals",
  "Check this client's synced Apple Health / Google Fit sleep and resting-heart-rate trend, if any. " +
    "This is a secondary caution alongside get_client_ai_history and get_platform_rejection_trends, not a hard constraint: if sleepTrend is 'declining' or restingHRTrend is 'elevated', default toward slightly lower volume/intensity this run unless the client's own profile, preferences, or check-ins clearly argue otherwise. If hasData is false, the client has no synced health data yet — ignore this signal entirely and build/adjust normally.",
  { clientId: z.string().min(1), days: z.number().int().min(1).max(90).default(14) },
  READ_ONLY,
  async ({ clientId, days }) =>
    guard(() =>
      gql(
        `query RecoverySignals($clientId: ID!, $days: Int) {
           recoverySignalSummary(clientId: $clientId, days: $days) {
             hasData daysWithData avgSleepMinutes avgRestingHeartRate sleepTrend restingHRTrend summary
           }
         }`,
        { clientId, days }
      )
    )
);

server.tool(
  "list_checkins",
  "List check-ins for the coach (optionally filtered to one client by user _id). " +
    "A check-in with status PENDING whose scheduledFor is in the past is overdue (the client did not respond).",
  { clientId: z.string().min(1).optional() },
  READ_ONLY,
  async ({ clientId }) =>
    guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `query CI($trainerId: ID!, $clientId: ID) {
           checkInsForTrainer(trainerId: $trainerId, clientId: $clientId) {
             _id clientId scheduledFor status acceptedAt rejectedAt respondedAt logWindowEndsAt
           }
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

// A conversation that asks "is it done?" after a create tool already ran a
// moment ago tends to get answered by re-invoking the very tool that "did"
// it, rather than a read-only check — observed live: one "confirm" + two
// "is it done?" follow-ups produced three near-identical workout plans and
// two near-identical diet plans for the same client, ~90 seconds apart,
// because nothing stopped a second confirm:true call from writing again.
// Guard the two create tools against that: if a plan with the same title
// for the same client was created inside this window, hand back the
// existing one instead of writing a duplicate. Matching rule lives in
// duplicate-guard.ts so it is unit-testable on its own.
async function findRecentDuplicatePlan(
  kind: "workout" | "diet",
  clientId: string,
  title: string,
): Promise<RecentPlan | null> {
  const query =
    kind === "workout"
      ? `query WP($clientId: ID!, $p: PaginationInput!) {
           workoutPlansForClient(clientId: $clientId, pagination: $p) { _id title createdAt }
         }`
      : `query DP($clientId: ID!, $p: PaginationInput!) {
           dietPlansForClient(clientId: $clientId, pagination: $p) { _id title createdAt }
         }`;
  const field = kind === "workout" ? "workoutPlansForClient" : "dietPlansForClient";

  const data = await gql<Record<string, RecentPlan[]>>(query, { clientId, p: PAGE });
  const plans = data[field] ?? [];
  return pickRecentDuplicate(plans, title, Date.now());
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

const rationaleFigure = z.object({
  label: z.string().min(1).describe('e.g. "Avg sleep", "TDEE", "Weight"'),
  value: z.string().min(1).describe('e.g. "5.4 h", "2,340 kcal", "78.4 kg"'),
  note: z.string().optional().describe('context, e.g. "down from 7.1 h last week"'),
});

server.tool(
  "record_plan_rationale",
  "Record the coach-voice explanation of the AI Coach run you are performing for this client — what you looked at, what you changed and why, and the numbers behind it. " +
    "This is exactly what the client reads on their 'Why this changed' screen, so write it like a human coach speaking to them: plain language, their real figures, no tool names, no mention of steps or systems. " +
    "Call this once, after you have created or adjusted their plans.",
  {
    clientId: z.string().min(1),
    headline: z
      .string()
      .min(1)
      .describe('One sentence on the intent, e.g. "Eased off lower body this week so you actually recover."'),
    inputs: z
      .array(rationaleFigure)
      .optional()
      .describe("The real figures you based the decision on (check-ins, recovery, compliance, measurements)."),
    changes: z
      .array(z.object({ what: z.string().min(1), why: z.string().min(1) }))
      .optional()
      .describe('Each concrete change and its reason, e.g. what: "Squats 5x5 to 3x5", why: "Sleep dropped and resting HR climbed."'),
    math: z
      .array(rationaleFigure)
      .optional()
      .describe("Calculations behind the plan (TDEE, macro targets, deficits) so the client sees it was worked out, not guessed."),
  },
  async ({ clientId, ...input }) =>
    guard(() =>
      gql(
        `mutation R($clientId: ID!, $input: RecordAICoachRunRationaleInput!) {
           recordAICoachRunRationale(clientId: $clientId, input: $input)
         }`,
        { clientId, input }
      )
    )
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
  "schedule_checkin",
  "Set a recurring weekly check-in schedule for a client (confirm-gated). " +
    "The backend will auto-create a check-in on the chosen day+time each week. " +
    "dayOfWeek: 0=Sun … 6=Sat. timeOfDay: HH:MM 24-hour. " +
    "Provide _id to update an existing schedule; omit to create a new one. " +
    "question.type: TEXT|NUMBER|SCALE|PHOTO.",
  {
    clientId: z.string().min(1),
    dayOfWeek: z.number().int().min(0).max(6).describe("0=Sunday, 1=Monday … 6=Saturday"),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).describe("HH:MM in 24-hour format, e.g. 09:00"),
    isActive: z.boolean().optional().default(true),
    questions: z
      .array(
        z.object({
          type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO"]),
          label: z.string().min(1),
          required: z.boolean().optional(),
        })
      )
      .optional(),
    scheduleId: z.string().min(1).optional().describe("Provide to update an existing schedule"),
    ...confirmField,
  },
  async ({ confirm, clientId, dayOfWeek, timeOfDay, isActive, questions, scheduleId }) => {
    const preview_data = { clientId, dayOfWeek, timeOfDay, isActive, questions, scheduleId };
    if (!confirm) return preview("schedule_checkin", preview_data);
    return guard(async () => {
      const normalizedQuestions = (questions ?? []).map((q) => ({
        ...q,
        id: crypto.randomUUID(),
      }));
      return gql(
        `mutation USC($input: UpsertCheckInScheduleInput!) {
           upsertCheckInSchedule(input: $input) {
             _id clientId dayOfWeek timeOfDay isActive
             questions { id type label required }
           }
         }`,
        {
          input: {
            ...(scheduleId ? { _id: scheduleId } : {}),
            clientId,
            dayOfWeek,
            timeOfDay,
            isActive,
            questions: normalizedQuestions,
          },
        }
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
  "Create a workout plan for a client (confirm-gated). To check whether one was already created — for example if asked \"is it done?\" — call list_workout_plans instead of calling this again; re-running this with confirm: true a second time for the same client and title returns the plan already on file rather than writing a duplicate. " +
    "exercises: array of { name, sets, reps, restSeconds?, section?, exerciseId?, notes?, modality?, ... }. " +
    "modality selects which parameters actually describe the work: STRENGTH (sets/reps/restSeconds) | INTERVAL (rounds + distanceMeters or durationSeconds + recoverySeconds + targetPace) | STEADY (durationSeconds or distanceMeters + targetPace) | AMRAP or EMOM (durationSeconds as the cap + rounds) | FOR_TIME | HOLD (durationSeconds). " +
    "Never describe a run as sets and reps: '6 x 400 m at 5k pace, 90 s jog' is modality INTERVAL with rounds 6, distanceMeters 400, recoverySeconds 90, targetPace '5k pace'. Call get_training_split first so the week has a real structure. " +
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
      const existing = await findRecentDuplicatePlan("workout", args.clientId, args.title);
      if (existing) {
        return {
          _id: existing._id,
          title: existing.title,
          note: `Already created ${Math.round((Date.now() - new Date(existing.createdAt).getTime()) / 1000)}s ago — returning the existing plan instead of creating a duplicate.`,
        };
      }
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
  "Create a diet plan for a client (confirm-gated). To check whether one was already created — for example if asked \"is it done?\" — call list_diet_plans instead of calling this again; re-running this with confirm: true a second time for the same client and title returns the plan already on file rather than writing a duplicate. " +
    "Prefer meals like { name, scheduledTime: 'HH:mm', order, days: [MONDAY..SUNDAY], section, calories, macros, description, ingredients }. " +
    "description: one short sentence explaining why this meal is included — shown to the client under the meal. " +
    "ingredients: REQUIRED on every meal — break each meal into its raw materials with real quantities — e.g. [{ name: 'Paneer', quantity: 60, unit: 'g', calories: 159, protein: 11, carbs: 2, fat: 13 }, { name: 'Cooking oil', quantity: 10, unit: 'ml', isCookingAddition: true, calories: 88, fat: 10 }]. A meal with only calories/macros and no ingredients is rejected. " +
    "Always include the cooking fat (oil/ghee/butter) as its own ingredient — it is easy to forget and adds real calories. Use get_ingredient_nutrition for the numbers, and make the ingredient calories/macros sum roughly to the meal's calories/macros. Whatever itemised breakdown you show the coach in chat MUST be sent here as the ingredients array, or the client's saved plan will lose every quantity. " +
    "Legacy slot values like BREAKFAST/LUNCH/DINNER/SNACK are accepted and auto-mapped.",
  {
    clientId: z.string().min(1),
    title: z.string().min(1),
    startDate: z.string().min(1).describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    meals: z.array(dietMealSchema).min(1).superRefine(requireItemisedMeals),
    ...confirmField,
  },
  async ({ confirm, meals, ...args }) => {
    const normalizedMeals = normalizeDietMeals(meals as Record<string, unknown>[]);
    if (!confirm) return preview("create_diet_plan", { ...args, meals: normalizedMeals });
    return guard(async () => {
      const existing = await findRecentDuplicatePlan("diet", args.clientId, args.title);
      if (existing) {
        return {
          _id: existing._id,
          title: existing.title,
          note: `Already created ${Math.round((Date.now() - new Date(existing.createdAt).getTime()) / 1000)}s ago — returning the existing plan instead of creating a duplicate.`,
        };
      }
      const trainerId = await trainerUserId();
      return gql(
        `mutation CD($input: CreateDietPlanInput!) { createDietPlan(input: $input) { _id title } }`,
        { input: { trainerId, ...args, meals: normalizedMeals } }
      );
    });
  }
);

/* ───────────── Edit / manage existing records (confirm-gated) ─────────────
 * These close the loop so the agent can maintain a client's programme, not
 * only create it: adjust or swap parts of a plan, retire a plan, tweak a
 * habit, move or cancel a session. Every one previews first and only mutates
 * with confirm: true, exactly like the create tools. */

server.tool(
  "update_workout_plan",
  "Edit an existing workout plan (confirm-gated). Pass planId plus only the fields to change. " +
    "exercises, if given, REPLACES the whole exercise list — send the full intended list, not just the changed ones; to change a single slot use swap_workout_exercise instead. " +
    "Each exercise follows the same shape as create_workout_plan (name, sets, reps, restSeconds?, section?, exerciseId?, notes?, modality?, …). days: optional [MONDAY..SUNDAY].",
  {
    planId: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    exercises: z.array(z.record(z.unknown())).optional(),
    days: z.array(z.string()).optional(),
    startDate: z.string().optional().describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    ...confirmField,
  },
  async ({ confirm, exercises, ...args }) => {
    const input = {
      ...args,
      ...(exercises ? { exercises: normalizeExercises(exercises) } : {}),
    };
    if (!confirm) return preview("update_workout_plan", input);
    return guard(() =>
      gql(`mutation UW($input: UpdateWorkoutPlanInput!) { updateWorkoutPlan(input: $input) { _id title } }`, { input })
    );
  }
);

server.tool(
  "swap_workout_exercise",
  "Replace a single exercise in a workout plan by its order (confirm-gated) — the surgical alternative to update_workout_plan. " +
    "exerciseOrder is the `order` of the slot to replace (see list_workout_plans). newExercise is one exercise in the create_workout_plan shape; carry over exerciseId from search_exercises when there's a catalog match.",
  {
    planId: z.string().min(1),
    exerciseOrder: z.number().int(),
    newExercise: z.record(z.unknown()),
    ...confirmField,
  },
  async ({ confirm, planId, exerciseOrder, newExercise }) => {
    const normalized = normalizeExercises([newExercise])[0];
    if (!confirm) return preview("swap_workout_exercise", { planId, exerciseOrder, newExercise: normalized });
    return guard(() =>
      gql(
        `mutation SW($planId: ID!, $exerciseOrder: Int!, $newExercise: ExerciseInput!) {
           swapWorkoutPlanExercise(planId: $planId, exerciseOrder: $exerciseOrder, newExercise: $newExercise) { _id title }
         }`,
        { planId, exerciseOrder, newExercise: normalized }
      )
    );
  }
);

server.tool(
  "delete_workout_plan",
  "Delete a workout plan for good (confirm-gated). The client loses access to it — prefer editing unless the coach clearly wants it gone.",
  { planId: z.string().min(1), ...confirmField },
  async ({ confirm, planId }) => {
    if (!confirm) return preview("delete_workout_plan", { planId });
    return guard(() => gql(`mutation DW($planId: ID!) { deleteWorkoutPlan(planId: $planId) }`, { planId }));
  }
);

server.tool(
  "update_diet_plan",
  "Edit an existing diet plan (confirm-gated). Pass planId plus only the fields to change. " +
    "meals, if given, REPLACES the whole meal list — send the full intended list. Each meal follows the create_diet_plan shape (name, scheduledTime 'HH:mm', order, days, section, calories, macros, description, ingredients).",
  {
    planId: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    meals: z.array(dietMealSchema).optional(),
    startDate: z.string().optional().describe("YYYY-MM-DD"),
    endDate: z.string().optional(),
    ...confirmField,
  },
  async ({ confirm, planId, meals, ...rest }) => {
    const input = {
      ...rest,
      ...(meals ? { meals: normalizeDietMeals(meals as Record<string, unknown>[]) } : {}),
    };
    if (!confirm) return preview("update_diet_plan", { planId, ...input });
    return guard(() =>
      gql(`mutation UD($planId: ID!, $input: UpdateDietPlanInput!) { updateDietPlan(planId: $planId, input: $input) { _id title } }`, {
        planId,
        input,
      })
    );
  }
);

server.tool(
  "delete_diet_plan",
  "Delete a diet plan for good (confirm-gated). The client loses access to it — prefer editing unless the coach clearly wants it gone.",
  { planId: z.string().min(1), ...confirmField },
  async ({ confirm, planId }) => {
    if (!confirm) return preview("delete_diet_plan", { planId });
    return guard(() => gql(`mutation DD($planId: ID!) { deleteDietPlan(planId: $planId) }`, { planId }));
  }
);

server.tool(
  "update_habit",
  "Edit a client's habit (confirm-gated). Pass habitId plus only the fields to change. " +
    "frequency: DAILY | WEEKLY | SPECIFIC_DAYS. tracker: CHECKBOX | STEPS | WATER | COUNTER. category is a HabitCategory. " +
    "daysOfWeek is 0..6 (Sun..Sat). Set isActive: false to pause a habit without deleting it.",
  {
    habitId: z.string().min(1),
    name: z.string().optional(),
    emoji: z.string().optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    frequency: z.string().optional(),
    targetCount: z.number().int().optional(),
    tracker: z.string().optional(),
    daysOfWeek: z.array(z.number().int()).optional(),
    reminderTime: z.string().optional().describe("HH:mm"),
    isActive: z.boolean().optional(),
    ...confirmField,
  },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("update_habit", args);
    return guard(() => gql(`mutation UH($input: UpdateHabitInput!) { updateHabit(input: $input) { _id name } }`, { input: args }));
  }
);

server.tool(
  "reschedule_session",
  "Move a session to a new time (confirm-gated). newStart/newEnd are ISO date-time strings. Both client and coach are notified by the existing flow.",
  {
    sessionId: z.string().min(1),
    newStart: z.string().min(1).describe("ISO date-time"),
    newEnd: z.string().min(1).describe("ISO date-time"),
    ...confirmField,
  },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("reschedule_session", args);
    return guard(() =>
      gql(
        `mutation RS($input: RescheduleSessionInput!) {
           rescheduleSession(input: $input) { _id scheduledStart scheduledEnd status }
         }`,
        { input: args }
      )
    );
  }
);

server.tool(
  "cancel_session",
  "Cancel a scheduled session (confirm-gated). Optionally give a short reason the client will see.",
  { sessionId: z.string().min(1), reason: z.string().optional(), ...confirmField },
  async ({ confirm, sessionId, reason }) => {
    if (!confirm) return preview("cancel_session", { sessionId, reason });
    return guard(() =>
      gql(`mutation CS($sessionId: ID!, $reason: String) { cancelSession(sessionId: $sessionId, reason: $reason) { _id status } }`, {
        sessionId,
        reason,
      })
    );
  }
);

server.tool(
  "send_message_to_client",
  "Send a chat message to one of the coach's clients (confirm-gated). It lands in the client's chat and sends them a push notification, exactly as if the coach typed it. Use the client's User._id (from list_clients). Write in the coach's voice, first person.",
  { clientId: z.string().min(1), text: z.string().min(1), ...confirmField },
  async ({ confirm, clientId, text }) => {
    if (!confirm) return preview("send_message_to_client", { clientId, text });
    return guard(() =>
      gql(
        `mutation SM($clientId: ID!, $text: String!) {
           sendClientMessage(clientId: $clientId, text: $text) { messageId roomId }
         }`,
        { clientId, text }
      )
    );
  }
);

/* ═════════════════════════ Prospects (CRM) ═════════════════════════
 * A coach's pre-client pipeline — leads captured from the profile form,
 * WhatsApp, or entered by hand. Distinct from Clients: a prospect has not
 * signed up on the platform yet. */

const PROSPECT_STATUS = z.enum(["NEW", "CONTACTED", "CONVERTED", "LOST"]);

server.tool(
  "list_prospects",
  "List the coach's prospects (leads who have not become clients yet). Optionally filter by status.",
  { status: PROSPECT_STATUS.optional(), pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  READ_ONLY,
  async ({ status, pageNumber, pageSize }) =>
    guard(() =>
      gql(
        `query PR($status: ProspectStatus, $p: PaginationInput!) {
           prospectsForTrainer(status: $status, pagination: $p) {
             _id name phone email goal status source notes { text createdAt } convertedClientId createdAt updatedAt
           }
         }`,
        { status, p: { pageNumber, pageSize } }
      )
    )
);

server.tool(
  "get_prospect_stats",
  "Counts of prospects by pipeline stage (new / contacted / converted / lost) for the coach.",
  {},
  READ_ONLY,
  async () => guard(() => gql(`query { prospectStats { new contacted converted lost total } }`))
);

server.tool(
  "create_prospect",
  "Manually add a prospect to the pipeline (confirm-gated) — for a lead that came in outside the platform (a call, a walk-in, a referral).",
  {
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional(),
    goal: z.string().optional(),
    note: z.string().optional(),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("create_prospect", input);
    return guard(() =>
      gql(`mutation CP($input: CreateProspectInput!) { createProspectManual(input: $input) { _id name status } }`, { input })
    );
  }
);

server.tool(
  "update_prospect_status",
  "Move a prospect to a new pipeline stage (confirm-gated). Use list_prospects to get the id.",
  { id: z.string().min(1), status: PROSPECT_STATUS, ...confirmField },
  async ({ confirm, id, status }) => {
    if (!confirm) return preview("update_prospect_status", { id, status });
    return guard(() =>
      gql(`mutation UPS($id: ID!, $status: ProspectStatus!) { updateProspectStatus(id: $id, status: $status) { _id status } }`, { id, status })
    );
  }
);

server.tool(
  "add_prospect_note",
  "Add a timestamped note to a prospect's record (confirm-gated) — e.g. what was discussed on a call.",
  { id: z.string().min(1), note: z.string().min(1), ...confirmField },
  async ({ confirm, id, note }) => {
    if (!confirm) return preview("add_prospect_note", { id, note });
    return guard(() =>
      gql(`mutation APN($id: ID!, $note: String!) { addProspectNote(id: $id, note: $note) { _id notes { text createdAt } } }`, { id, note })
    );
  }
);

/* ═════════════════════════ Ratings ═════════════════════════
 * Read-only: a coach checking their own client reviews. Clients rate their
 * coach from the client app — there is no coach-initiated write here. */

server.tool(
  "get_my_ratings",
  "The coach's own client ratings/reviews (public ones only — a client can mark theirs private), newest first.",
  { limit: z.number().int().min(1).max(100).optional() },
  READ_ONLY,
  async ({ limit }) => {
    const trainerId = await trainerUserId();
    return guard(() =>
      gql(
        `query R($trainerId: ID!, $limit: Int) { ratingsForTrainer(trainerId: $trainerId, limit: $limit) { _id stars comment createdAt } }`,
        { trainerId, limit }
      )
    );
  }
);

server.tool(
  "get_my_rating_summary",
  "The coach's average star rating and review count.",
  {},
  READ_ONLY,
  async () => {
    const trainerId = await trainerUserId();
    return guard(() => gql(`query S($trainerId: ID!) { ratingSummaryForTrainer(trainerId: $trainerId) { average count } }`, { trainerId }));
  }
);

/* ═════════════════════════ Plan Templates ═════════════════════════
 * Reusable workout/diet templates the coach builds once and reuses across
 * clients — distinct from create_workout_plan/create_diet_plan, which
 * assign a live plan to one specific client. */

const TEMPLATE_VISIBILITY = z.enum(["PRIVATE", "PUBLIC"]);
const TEMPLATE_DIFFICULTY = z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]);
const TEMPLATE_GOAL = z.enum(["FAT_LOSS", "MUSCLE_GAIN", "STRENGTH", "GENERAL_FITNESS"]);
const templatePaginationField = {
  pageNumber: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  tag: z.string().optional(),
  onlyMine: z.boolean().optional(),
};

server.tool(
  "list_workout_plan_templates",
  "List the coach's workout plan templates (id, title, tags, difficulty, goal).",
  templatePaginationField,
  READ_ONLY,
  async ({ pageNumber, pageSize, search, tag, onlyMine }) => {
    const trainerId = await trainerUserId();
    return guard(() =>
      gql(
        `query T($trainerId: ID!, $p: TemplatesPaginationInput!) {
           workoutPlanTemplatesForTrainer(trainerId: $trainerId, pagination: $p) {
             _id title description tags visibility difficulty goal usageCount isMarketplace price currency
           }
         }`,
        { trainerId, p: { pageNumber, pageSize, search, tag, onlyMine } }
      )
    );
  }
);

server.tool(
  "list_diet_plan_templates",
  "List the coach's diet plan templates (id, title, tags, difficulty, goal).",
  templatePaginationField,
  READ_ONLY,
  async ({ pageNumber, pageSize, search, tag, onlyMine }) => {
    const trainerId = await trainerUserId();
    return guard(() =>
      gql(
        `query T($trainerId: ID!, $p: TemplatesPaginationInput!) {
           dietPlanTemplatesForTrainer(trainerId: $trainerId, pagination: $p) {
             _id title description tags visibility difficulty goal usageCount isMarketplace price currency
           }
         }`,
        { trainerId, p: { pageNumber, pageSize, search, tag, onlyMine } }
      )
    );
  }
);

server.tool(
  "get_workout_plan_template",
  "Full detail of one workout plan template, including every exercise.",
  { id: z.string().min(1) },
  READ_ONLY,
  async ({ id }) =>
    guard(() =>
      gql(
        `query T($id: ID!) { workoutPlanTemplateById(id: $id) { _id title description tags difficulty goal exercises { name sets reps restSeconds section order exerciseId } } }`,
        { id }
      )
    )
);

server.tool(
  "get_diet_plan_template",
  "Full detail of one diet plan template, including every meal.",
  { id: z.string().min(1) },
  READ_ONLY,
  async ({ id }) =>
    guard(() =>
      gql(
        `query T($id: ID!) { dietPlanTemplateById(id: $id) { _id title description tags difficulty goal meals { name scheduledTime section calories order days } } }`,
        { id }
      )
    )
);

server.tool(
  "create_workout_plan_template",
  "Save a reusable workout plan template (confirm-gated). exercises follow the same shape as create_workout_plan's.",
  {
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: TEMPLATE_VISIBILITY,
    difficulty: TEMPLATE_DIFFICULTY.optional(),
    goal: TEMPLATE_GOAL.optional(),
    exercises: z.array(z.record(z.unknown())).min(1),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("create_workout_plan_template", input);
    return guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `mutation CT($trainerId: ID!, $input: CreateWorkoutPlanTemplateInput!) { createWorkoutPlanTemplate(trainerId: $trainerId, input: $input) { _id title } }`,
        { trainerId, input }
      );
    });
  }
);

server.tool(
  "create_diet_plan_template",
  "Save a reusable diet plan template (confirm-gated). meals follow the same shape as create_diet_plan's — every meal must include a non-empty ingredients array with quantities.",
  {
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: TEMPLATE_VISIBILITY,
    difficulty: TEMPLATE_DIFFICULTY.optional(),
    goal: TEMPLATE_GOAL.optional(),
    meals: z.array(z.record(z.unknown())).min(1).superRefine(requireItemisedMeals),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("create_diet_plan_template", input);
    return guard(async () => {
      const trainerId = await trainerUserId();
      return gql(
        `mutation CT($trainerId: ID!, $input: CreateDietPlanTemplateInput!) { createDietPlanTemplate(trainerId: $trainerId, input: $input) { _id title } }`,
        { trainerId, input }
      );
    });
  }
);

server.tool(
  "update_workout_plan_template",
  "Edit an existing workout plan template (confirm-gated). Only send the fields that change.",
  {
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: TEMPLATE_VISIBILITY.optional(),
    difficulty: TEMPLATE_DIFFICULTY.optional(),
    goal: TEMPLATE_GOAL.optional(),
    exercises: z.array(z.record(z.unknown())).optional(),
    ...confirmField,
  },
  async ({ confirm, id, ...input }) => {
    if (!confirm) return preview("update_workout_plan_template", { id, ...input });
    return guard(() =>
      gql(`mutation UT($id: ID!, $input: UpdateWorkoutPlanTemplateInput!) { updateWorkoutPlanTemplate(id: $id, input: $input) { _id title } }`, { id, input })
    );
  }
);

server.tool(
  "update_diet_plan_template",
  "Edit an existing diet plan template (confirm-gated). Only send the fields that change.",
  {
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    visibility: TEMPLATE_VISIBILITY.optional(),
    difficulty: TEMPLATE_DIFFICULTY.optional(),
    goal: TEMPLATE_GOAL.optional(),
    meals: z.array(z.record(z.unknown())).optional(),
    ...confirmField,
  },
  async ({ confirm, id, ...input }) => {
    if (!confirm) return preview("update_diet_plan_template", { id, ...input });
    return guard(() =>
      gql(`mutation UT($id: ID!, $input: UpdateDietPlanTemplateInput!) { updateDietPlanTemplate(id: $id, input: $input) { _id title } }`, { id, input })
    );
  }
);

server.tool(
  "delete_workout_plan_template",
  "Permanently delete a workout plan template (confirm-gated). This does not touch any plan already assigned to a client from it.",
  { id: z.string().min(1), ...confirmField },
  async ({ confirm, id }) => {
    if (!confirm) return preview("delete_workout_plan_template", { id });
    return guard(() => gql(`mutation DT($id: ID!) { deleteWorkoutPlanTemplate(id: $id) }`, { id }));
  }
);

server.tool(
  "delete_diet_plan_template",
  "Permanently delete a diet plan template (confirm-gated). This does not touch any plan already assigned to a client from it.",
  { id: z.string().min(1), ...confirmField },
  async ({ confirm, id }) => {
    if (!confirm) return preview("delete_diet_plan_template", { id });
    return guard(() => gql(`mutation DT($id: ID!) { deleteDietPlanTemplate(id: $id) }`, { id }));
  }
);

server.tool(
  "set_workout_plan_template_marketplace",
  "List or unlist a workout plan template on the Trainzilla marketplace, and set its price (confirm-gated). This does not process any payment — it only makes the template available for other coaches to buy.",
  { templateId: z.string().min(1), isMarketplace: z.boolean(), price: z.number().int().min(0).optional(), currency: z.string().optional(), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("set_workout_plan_template_marketplace", args);
    return guard(() =>
      gql(
        `mutation M($templateId: ID!, $isMarketplace: Boolean!, $price: Int, $currency: String) { setWorkoutPlanTemplateMarketplace(templateId: $templateId, isMarketplace: $isMarketplace, price: $price, currency: $currency) { _id isMarketplace price currency } }`,
        args
      )
    );
  }
);

server.tool(
  "set_diet_plan_template_marketplace",
  "List or unlist a diet plan template on the Trainzilla marketplace, and set its price (confirm-gated). This does not process any payment — it only makes the template available for other coaches to buy.",
  { templateId: z.string().min(1), isMarketplace: z.boolean(), price: z.number().int().min(0).optional(), currency: z.string().optional(), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("set_diet_plan_template_marketplace", args);
    return guard(() =>
      gql(
        `mutation M($templateId: ID!, $isMarketplace: Boolean!, $price: Int, $currency: String) { setDietPlanTemplateMarketplace(templateId: $templateId, isMarketplace: $isMarketplace, price: $price, currency: $currency) { _id isMarketplace price currency } }`,
        args
      )
    );
  }
);

/* ═════════════════════════ Invitations ═════════════════════════ */

server.tool(
  "list_invitations",
  "List invitations the coach has sent to prospective clients (pending, accepted, rejected).",
  { pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  READ_ONLY,
  async ({ pageNumber, pageSize }) => {
    const trainerId = await trainerUserId();
    return guard(() =>
      gql(
        `query I($trainerId: ID!, $p: PaginationInput!) { getInvitationsForTrainer(trainerId: $trainerId, pagination: $p) { _id email status type expiresAt createdAt } }`,
        { trainerId, p: { pageNumber, pageSize } }
      )
    );
  }
);

server.tool(
  "get_my_pending_org_invitations",
  "Organization invitations this coach has received and not yet responded to (e.g. an invite to join a gym as staff).",
  {},
  READ_ONLY,
  async () => guard(() => gql(`query { myCoachInvitations { _id email status type organization { name } expiresAt } }`))
);

server.tool(
  "send_invitation",
  "Invite a prospective client to join Trainzilla under this coach, by email (confirm-gated). They receive an email with a signup link.",
  { email: z.string().email(), expiresInHours: z.number().int().positive().optional(), ...confirmField },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("send_invitation", input);
    return guard(() =>
      gql(`mutation SI($input: SendInvitationInput!) { sendInvitation(input: $input) { _id email status expiresAt } }`, { input })
    );
  }
);

server.tool(
  "remove_client",
  "End the coaching relationship with a client (confirm-gated). This does not delete the client's account or history — it only disconnects them from this coach. Irreversible from this tool; the client would need to re-request or be re-invited.",
  { clientId: z.string().min(1), ...confirmField },
  async ({ confirm, clientId }) => {
    if (!confirm) return preview("remove_client", { clientId });
    return guard(() => gql(`mutation RC($clientId: ID!) { removeClient(clientId: $clientId) }`, { clientId }));
  }
);

/* ═════════════════════════ Trainer Profile ═════════════════════════
 * The coach's own public/business profile — separate from client-facing
 * tools, which never touch the coach's own record. Onboarding-only
 * mutations (initOnboarding/saveAvailabilityStep/completeOnboarding/
 * createTrainer) are deliberately not exposed: they only make sense once,
 * during signup, before an AI conversation would ever be connected. */

server.tool(
  "get_my_profile",
  "The coach's own full profile — contact info, professional info (specialties, certifications, bio), availability, and public transformations/testimonials. Bank details are never returned by this tool.",
  {},
  READ_ONLY,
  async () =>
    guard(() =>
      gql(
        `query {
           user { _id name email }
           trainer {
             userId publicSlug isProfileCompleted isVerified gender dateOfBirth
             professional {
               specialties certifications yearsOfExperience bio businessType languages
               profilePhoto gallery certificateFiles
               socialLinks { name link }
               mediaLinks { name link }
             }
             contact { phone addressLine1 addressLine2 city state country postalCode }
             availability { preferredTime daysAvailable checkIn checkOut timezone }
             transformations { clientName timeline beforeImages afterImages transformationGoal resultsAndAchievements }
             testimonials { clientName profileImage note }
           }
         }`
      )
    )
);

server.tool(
  "update_my_contact",
  "Update the coach's own contact info (confirm-gated). Sends the full object — fields omitted are cleared, so read get_my_profile first if only changing one field.",
  {
    phone: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().optional(),
    country: z.string().min(1),
    postalCode: z.string().optional(),
    ...confirmField,
  },
  async ({ confirm, ...contact }) => {
    if (!confirm) return preview("update_my_contact", contact);
    return guard(() =>
      gql(`mutation UC($input: UpdateTrainerContactInput!) { updateTrainerContact(input: $input) { userId contact { phone city } } }`, {
        input: { contact },
      })
    );
  }
);

server.tool(
  "update_my_bank",
  "Update the coach's own payout bank account (confirm-gated). This is where Trainzilla sends the coach's earnings — get explicit confirmation of the exact account/IFSC from the coach before calling with confirm: true, this tool's own preview is not enough given how consequential a wrong account number is.",
  {
    accountHolderName: z.string().min(1),
    accountNumber: z.string().min(1),
    ifscCode: z.string().min(1),
    bankName: z.string().min(1),
    ...confirmField,
  },
  async ({ confirm, ...bankDetails }) => {
    if (!confirm) return preview("update_my_bank", bankDetails);
    return guard(() =>
      gql(`mutation UB($input: UpdateTrainerBankInput!) { updateTrainerBank(input: $input) { userId } }`, {
        input: { bankDetails },
      })
    );
  }
);

server.tool(
  "update_my_professional",
  "Update the coach's own professional info — specialties, certifications, years of experience, bio, languages, business type (confirm-gated). Sends the full object; read get_my_profile first if only changing one field.",
  {
    specialties: z.array(z.string()).min(1),
    certifications: z.array(z.string()),
    yearsOfExperience: z.number().int().min(0),
    bio: z.string().optional(),
    businessType: z.string(),
    languages: z.array(z.string()).min(1),
    profilePhoto: z.string(),
    gallery: z.array(z.string()),
    certificateFiles: z.array(z.string()),
    ...confirmField,
  },
  async ({ confirm, ...professional }) => {
    if (!confirm) return preview("update_my_professional", professional);
    return guard(() =>
      gql(`mutation UP($input: UpdateTrainerProfessionalInput!) { updateTrainerProfessional(input: $input) { userId professional { bio } } }`, {
        input: { professional },
      })
    );
  }
);

server.tool(
  "update_my_availability",
  "Update when the coach is bookable for sessions (confirm-gated). This is the same availability that drives trainerAvailableHourSlotsNext7Days / session booking.",
  {
    preferredTime: z.string(),
    daysAvailable: z.array(z.string()).min(1),
    checkIn: z.string().regex(/^\d{2}:\d{2}$/),
    checkOut: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string(),
    ...confirmField,
  },
  async ({ confirm, ...availability }) => {
    if (!confirm) return preview("update_my_availability", availability);
    return guard(() =>
      gql(`mutation UA($input: UpdateTrainerAvailabilityInput!) { updateTrainerAvailability(input: $input) { userId } }`, {
        input: { availability },
      })
    );
  }
);

server.tool(
  "update_my_transformations",
  "Replace the coach's own public before/after client transformation gallery (confirm-gated). Sends the full list — read get_my_profile first if only adding one.",
  {
    transformations: z.array(z.object({
      clientName: z.string().min(1),
      timeline: z.string().min(1),
      beforeImages: z.array(z.string()),
      afterImages: z.array(z.string()),
      transformationGoal: z.string(),
      resultsAndAchievements: z.array(z.string()),
      resultsText: z.string().optional(),
    })),
    ...confirmField,
  },
  async ({ confirm, transformations }) => {
    if (!confirm) return preview("update_my_transformations", { transformations });
    return guard(() =>
      gql(`mutation UT($input: UpdateTrainerTransformationsInput!) { updateTrainerTransformations(input: $input) { userId } }`, {
        input: { transformations },
      })
    );
  }
);

server.tool(
  "update_my_testimonials",
  "Replace the coach's own public client testimonials (confirm-gated). Sends the full list — read get_my_profile first if only adding one.",
  {
    testimonials: z.array(z.object({
      clientName: z.string().min(1),
      profileImage: z.string(),
      note: z.string().min(1),
    })),
    ...confirmField,
  },
  async ({ confirm, testimonials }) => {
    if (!confirm) return preview("update_my_testimonials", { testimonials });
    return guard(() =>
      gql(`mutation UT($input: UpdateTrainerTestimonialsInput!) { updateTrainerTestimonials(input: $input) { userId } }`, {
        input: { testimonials },
      })
    );
  }
);

/* ═════════════════════════ Organization ═════════════════════════
 * Multi-coach teams / gyms. Only meaningful for a coach who owns or
 * manages an organization — resolvers enforce that server-side.
 *
 * Deliberately NOT exposed: createOrganizationSubscription and
 * confirmOrganizationSubscriptionCheckout. The confirm step needs a real
 * razorpaySignature produced by Razorpay's checkout widget after an actual
 * payment completes — nothing an AI agent can produce or drive — so wiring
 * only the first half would create a subscription intent this tool can
 * never finish. Seat/billing changes stay a human action in the app. */

server.tool(
  "list_my_organizations",
  "Organizations the coach belongs to (owns, manages, or is a member of), with their role in each.",
  {},
  READ_ONLY,
  async () => guard(() => gql(`query { organizations { _id name isActive myRole } }`))
);

server.tool(
  "get_organization_hierarchy",
  "Full org structure: locations, coaches with their roles and assigned locations, and pending invites. Use list_my_organizations for the id.",
  { organizationId: z.string().min(1) },
  READ_ONLY,
  async ({ organizationId }) =>
    guard(() =>
      gql(
        `query H($organizationId: ID!) { organizationHierarchy(organizationId: $organizationId) {
           overview { totalCoaches totalLocations totalPendingInvites }
           members { coach { userId name } organizationRole clientCount revenue }
           locations { location { _id name } totalClients totalRevenue }
           pendingInvites { invitationId email organizationRole expiresAt }
         } }`,
        { organizationId }
      )
    )
);

server.tool(
  "list_organization_locations",
  "List an organization's locations/branches.",
  { organizationId: z.string().min(1) },
  READ_ONLY,
  async ({ organizationId }) => guard(() => gql(`query L($organizationId: ID!) { locations(organizationId: $organizationId) { _id name address isActive } }`, { organizationId }))
);

server.tool(
  "list_organization_coaches",
  "List coaches in an organization, optionally filtered to one location, with each coach's client count and revenue.",
  { organizationId: z.string().min(1), locationId: z.string().optional() },
  READ_ONLY,
  async ({ organizationId, locationId }) =>
    guard(() =>
      gql(
        `query C($organizationId: ID!, $locationId: ID) { organizationCoaches(organizationId: $organizationId, locationId: $locationId) {
           coach { userId name } role location { name } clientCount revenue
         } }`,
        { organizationId, locationId }
      )
    )
);

server.tool(
  "list_organization_clients",
  "List an organization's clients, optionally filtered by location or coach.",
  { organizationId: z.string().min(1), locationId: z.string().optional(), coachId: z.string().optional(), pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  READ_ONLY,
  async ({ organizationId, locationId, coachId, pageNumber, pageSize }) =>
    guard(() =>
      gql(
        `query OC($organizationId: ID!, $locationId: ID, $coachId: ID, $p: PaginationInput!) {
           organizationClients(organizationId: $organizationId, locationId: $locationId, coachId: $coachId, pagination: $p) {
             profileId user { _id name email } coach { name } location { name }
           }
         }`,
        { organizationId, locationId, coachId, p: { pageNumber, pageSize } }
      )
    )
);

server.tool(
  "get_organization_dashboard",
  "Organization-wide totals: clients and revenue overall, and broken down per location and per coach.",
  { organizationId: z.string().min(1), locationId: z.string().optional(), coachId: z.string().optional() },
  READ_ONLY,
  async ({ organizationId, locationId, coachId }) =>
    guard(() =>
      gql(
        `query D($organizationId: ID!, $locationId: ID, $coachId: ID) { organizationDashboard(organizationId: $organizationId, locationId: $locationId, coachId: $coachId) {
           totalClients totalRevenue
           totalClientsPerLocation { locationName clientCount revenue }
           totalClientsPerCoach { coachName clientCount revenue }
         } }`,
        { organizationId, locationId, coachId }
      )
    )
);

server.tool(
  "get_organization_seat_usage",
  "How many of the organization's paid coach seats are used vs. the current plan's limit.",
  { organizationId: z.string().min(1) },
  READ_ONLY,
  async ({ organizationId }) => guard(() => gql(`query S($organizationId: ID!) { organizationSeatUsage(organizationId: $organizationId) { tier seatLimit seatsUsed hasActiveSubscription } }`, { organizationId }))
);

server.tool(
  "get_organization_coach_attendance",
  "A location's coach attendance roster for one date.",
  { organizationId: z.string().min(1), attendanceDate: z.string().min(1).describe("YYYY-MM-DD"), locationId: z.string().optional() },
  READ_ONLY,
  async ({ organizationId, attendanceDate, locationId }) =>
    guard(() =>
      gql(
        `query A($organizationId: ID!, $attendanceDate: String!, $locationId: ID) { organizationCoachAttendance(organizationId: $organizationId, attendanceDate: $attendanceDate, locationId: $locationId) {
           totalPresent totalAbsent totalLate totalLeave
           entries { coach { name } location { name } record { status notes } }
         } }`,
        { organizationId, attendanceDate, locationId }
      )
    )
);

server.tool(
  "create_organization",
  "Create a new organization (confirm-gated) — the coach becomes its owner.",
  { name: z.string().min(1), ...confirmField },
  async ({ confirm, name }) => {
    if (!confirm) return preview("create_organization", { name });
    return guard(() => gql(`mutation CO($name: String!) { createOrganization(name: $name) { _id name } }`, { name }));
  }
);

server.tool(
  "update_organization",
  "Rename an organization (confirm-gated).",
  { organizationId: z.string().min(1), name: z.string().min(1), ...confirmField },
  async ({ confirm, organizationId, name }) => {
    if (!confirm) return preview("update_organization", { organizationId, name });
    return guard(() => gql(`mutation UO($organizationId: ID!, $name: String!) { updateOrganization(organizationId: $organizationId, name: $name) { _id name } }`, { organizationId, name }));
  }
);

server.tool(
  "create_organization_location",
  "Add a new location/branch to an organization (confirm-gated).",
  { organizationId: z.string().min(1), name: z.string().min(1), address: z.string().min(1), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("create_organization_location", args);
    return guard(() => gql(`mutation CL($organizationId: ID!, $name: String!, $address: String!) { createLocation(organizationId: $organizationId, name: $name, address: $address) { _id name } }`, args));
  }
);

server.tool(
  "update_organization_location",
  "Rename or re-address an existing location (confirm-gated).",
  { locationId: z.string().min(1), name: z.string().min(1), address: z.string().min(1), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("update_organization_location", args);
    return guard(() => gql(`mutation UL($locationId: ID!, $name: String!, $address: String!) { updateLocation(locationId: $locationId, name: $name, address: $address) { _id name } }`, args));
  }
);

server.tool(
  "delete_organization_location",
  "Permanently delete a location (confirm-gated). Coaches and clients assigned to it are not moved automatically — reassign them first.",
  { locationId: z.string().min(1), ...confirmField },
  async ({ confirm, locationId }) => {
    if (!confirm) return preview("delete_organization_location", { locationId });
    return guard(() => gql(`mutation DL($locationId: ID!) { deleteLocation(locationId: $locationId) }`, { locationId }));
  }
);

server.tool(
  "invite_coach_to_organization",
  "Invite a coach to join the organization by email, with a role and optional location (confirm-gated). They receive a real email.",
  {
    organizationId: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["OWNER", "ADMIN", "PRIMARY_COACH", "COACH"]),
    locationId: z.string().optional(),
    expiresInHours: z.number().int().positive().optional(),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("invite_coach_to_organization", input);
    return guard(() => gql(`mutation IC($input: InviteCoachInput!) { inviteCoach(input: $input) { _id email status } }`, { input }));
  }
);

server.tool(
  "invite_client_to_organization",
  "Invite a client to join the organization by email, optionally pre-assigned to a coach and location (confirm-gated). They receive a real email.",
  {
    organizationId: z.string().min(1),
    email: z.string().email(),
    coachId: z.string().optional(),
    locationId: z.string().optional(),
    expiresInHours: z.number().int().positive().optional(),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("invite_client_to_organization", input);
    return guard(() => gql(`mutation IC($input: InviteClientToOrganizationInput!) { inviteClientToOrganization(input: $input) { _id email status } }`, { input }));
  }
);

server.tool(
  "update_organization_coach_role",
  "Change a coach's role within the organization (confirm-gated) — an access-control change, not a display label. Get explicit confirmation from the coach of exactly which member and which new role before calling with confirm: true.",
  { organizationId: z.string().min(1), coachId: z.string().min(1), role: z.enum(["OWNER", "ADMIN", "PRIMARY_COACH", "COACH"]), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("update_organization_coach_role", args);
    return guard(() =>
      gql(
        `mutation R($organizationId: ID!, $coachId: ID!, $role: OrganizationRole!) { updateOrganizationCoachRole(organizationId: $organizationId, coachId: $coachId, role: $role) { coach { name } organizationRole } }`,
        args
      )
    );
  }
);

server.tool(
  "assign_coach_to_location",
  "Assign or move a coach to a location within the organization, with a role there (confirm-gated).",
  {
    organizationId: z.string().min(1),
    coachId: z.string().min(1),
    locationId: z.string().min(1),
    role: z.enum(["ADMIN", "PRIMARY_COACH", "COACH"]),
    makePrimary: z.boolean().optional(),
    ...confirmField,
  },
  async ({ confirm, makePrimary, ...args }) => {
    if (!confirm) return preview("assign_coach_to_location", { ...args, makePrimary });
    return guard(() =>
      gql(
        `mutation A($input: UpsertOrganizationLocationAssignmentInput!) { upsertOrganizationLocationAssignment(input: $input) { coach { name } locationAssignments { location { name } role isPrimary } } }`,
        { input: { ...args, makePrimary: makePrimary ?? false } }
      )
    );
  }
);

server.tool(
  "remove_coach_location_assignment",
  "Unassign a coach from a location within the organization (confirm-gated). Does not remove them from the organization itself — use remove_coach_from_organization for that.",
  { organizationId: z.string().min(1), coachId: z.string().min(1), locationId: z.string().min(1), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("remove_coach_location_assignment", args);
    return guard(() =>
      gql(`mutation R($input: RemoveOrganizationLocationAssignmentInput!) { removeOrganizationLocationAssignment(input: $input) { coach { name } } }`, { input: args })
    );
  }
);

server.tool(
  "remove_coach_from_organization",
  "Remove a coach from the organization entirely (confirm-gated) — high impact: optionally transfer their clients to another coach in the same call, or their clients are left unassigned. Get explicit confirmation of exactly which coach, and where their clients go, before calling with confirm: true.",
  { organizationId: z.string().min(1), coachId: z.string().min(1), transferClientCoachId: z.string().optional(), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("remove_coach_from_organization", args);
    return guard(() =>
      gql(
        `mutation RC($organizationId: ID!, $coachId: ID!, $transferClientCoachId: ID) { removeCoach(organizationId: $organizationId, coachId: $coachId, transferClientCoachId: $transferClientCoachId) }`,
        args
      )
    );
  }
);

server.tool(
  "reassign_client_to_coach",
  "Move one of an organization's clients from their current coach to a different coach in the same organization (confirm-gated).",
  { organizationId: z.string().min(1), profileId: z.string().min(1), coachId: z.string().min(1), ...confirmField },
  async ({ confirm, ...args }) => {
    if (!confirm) return preview("reassign_client_to_coach", args);
    return guard(() =>
      gql(
        `mutation RC($organizationId: ID!, $profileId: ID!, $coachId: ID!) { reassignClient(organizationId: $organizationId, profileId: $profileId, coachId: $coachId) { profileId coach { name } } }`,
        args
      )
    );
  }
);

server.tool(
  "record_organization_coach_attendance",
  "Mark a coach present/absent/late/on-leave at a location for a date (confirm-gated).",
  {
    organizationId: z.string().min(1),
    coachId: z.string().min(1),
    locationId: z.string().min(1),
    attendanceDate: z.string().min(1).describe("YYYY-MM-DD"),
    status: z.enum(["PRESENT", "ABSENT", "LATE", "LEAVE"]),
    notes: z.string().optional(),
    ...confirmField,
  },
  async ({ confirm, ...input }) => {
    if (!confirm) return preview("record_organization_coach_attendance", input);
    return guard(() =>
      gql(
        `mutation A($input: UpsertOrganizationCoachAttendanceInput!) { upsertOrganizationCoachAttendance(input: $input) { _id status attendanceDate } }`,
        { input: { ...input, source: "MANUAL" } }
      )
    );
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
            `1. get_client_profile(clientId: "${clientId}")\n` +
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

const SERVER_INSTRUCTIONS = [
  "Trainzilla coaching data for one coach (your API key scopes everything to you).",
  "",
  "Identifiers:",
  "- `clientId` everywhere is the client's User `_id` — the value list_clients returns as `_id`.",
  "  It is NOT a Client document id. get_client_profile also accepts `userId` as an alias.",
  "",
  "Client stats:",
  "- gender is MALE | FEMALE | OTHER. Pass OTHER through to calc_tdee as-is; do not coerce it.",
  "- Monetary values are in the smallest currency unit (paise for INR). Divide by 100 before showing them.",
  "",
  "Writing plans:",
  "- Mutation tools (create_*, update_*, delete_*, schedule_*, assign_*) preview unless `confirm: true`.",
  "  Always show the preview to the coach first.",
  "- create_diet_plan / create_diet_plan_template REJECT a meal that has only calories/macros. Every",
  "  meal must be itemised: each raw ingredient with a numeric `quantity` and `unit`, including the",
  "  cooking oil/ghee as its own ingredient. Use get_ingredient_nutrition for the numbers and make the",
  "  ingredients sum to the meal total. Whatever breakdown you showed the coach in chat MUST be the",
  "  ingredients array you send.",
  "- Before create_workout_plan / create_diet_plan, call list_workout_plans / list_diet_plans for the",
  "  client and don't create a near-duplicate of a plan that already covers the same dates.",
  "",
  "Check-ins: a check-in with status PENDING whose scheduledFor is in the past is overdue — the client",
  "never responded.",
  "",
  "Photo analysis needs three calls in order: list_checkins -> get_checkin_answers (pulls PHOTO answer",
  "URLs) -> get_client_images (fetches them as base64).",
].join("\n");

/** Build a fully-registered MCP server instance. */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "tzilla-coach", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
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
