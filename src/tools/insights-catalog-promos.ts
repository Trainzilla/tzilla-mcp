import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gql } from "../client.js";
import { normalizeExercises } from "../index.js";
import { confirmField, guard, preview, readTool, writeTool, TRAINER, WRITE, REGISTERED_DOCS, buildDoc } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const SUBSCRIPTION = `_id status renewalStatus startedAt currentPeriodEnd paymentProvider planId
  plan { _id name amount currency period interval } pauses { startAt endAt reason }`;
const CATALOG_EXERCISE = `id name bodyPart target equipment disciplines custom editable videoUrl previewImage { url }`;
const COUPON = `id code percentOff planIds maxRedemptions redemptions expiresAt isActive createdAt`;
const CHALLENGE = `id title description startDate endDate isActive forWholeGym phase participantCount`;
const TEMPLATE_EXERCISE = `exerciseId name sets reps repsMin restSeconds order section notes modality rounds durationSeconds
  distanceMeters recoverySeconds targetPace supersetGroup effort`;
const SECTION_TEMPLATE = `_id name section ownedByOrganization updatedAt exercises { ${TEMPLATE_EXERCISE} }`;

const exercisesArg = z
  .array(z.record(z.unknown()))
  .min(1)
  .describe(
    "[{ name, sets, reps, restSeconds?, exerciseId?, notes?, modality?, supersetGroup?, ... }] — same shape as create_workout_plan exercises; reps can be a range like \"8-12\".",
  );

export function registerInsightsCatalogPromoTools(server: McpServer): void {
  /* ── Client insights ── */
  readTool(server, {
    name: "get_client_roster",
    desc: "Every client sorted into segments (NEEDS_PROGRAMMING, INACTIVE, NEW, PLAN_ENDING, ON_TRACK) with last activity, 7/30-day workout adherence and plan-end countdown. Best first call for 'who needs attention?'. Rows carry clientId only — join names with list_clients.",
    field: "clientRoster",
    select: `generatedAt counts { segment count } rows { clientId segments lastActivityDate daysSinceActivity workoutAdherence7Pct
      workoutAdherence30Pct plannedWorkoutDaysNext7 hasWorkoutPlan hasDietPlan planEndsInDays }`,
  });
  readTool(server, {
    name: "list_clients_with_declining_recovery",
    desc: "Clients whose sleep or resting heart rate (from Apple Health / Health Connect) is trending the wrong way over the window. Use get_recovery_signals for one client's detail.",
    field: "clientsWithDecliningRecovery",
    args: "days: Int",
    select: "clientId clientName hasData daysWithData avgSleepMinutes avgRestingHeartRate sleepTrend restingHRTrend summary isDeclining",
    shape: { days: z.number().int().min(3).max(90).optional().describe("Window in days (default set by the server)") },
  });
  readTool(server, {
    name: "get_habit_adherence_all_clients",
    desc: "Habit adherence % and best current streak for every client over the window — the cross-client view. Use get_habit_compliance for one client's day-by-day.",
    field: "habitAdherenceForTrainer",
    args: "trainerId: ID!, days: Int",
    select: "clientId clientName habitCount adherencePct bestCurrentStreak loggedInWindow lastLoggedDate",
    shape: { days: z.number().int().min(1).max(90).optional() },
    resolve: TRAINER,
  });
  readTool(server, {
    name: "get_client_workout_streak",
    desc: "A client's current and longest workout-day streak, plus which streak badges they have earned.",
    field: "workoutStreak",
    args: "clientId: ID!",
    select: "current longest badges { days earned }",
    shape: { clientId },
  });
  readTool(server, {
    name: "list_ai_run_history",
    desc: "Past AI-coach runs (plans generated, check-in replies, adjustments) for your clients, newest first, with status, rationale and created artifacts. Pass clientId to narrow to one client.",
    field: "myAiRunHistoryForClients",
    args: "clientId: ID, limit: Int",
    select: `_id clientId clientName type status error rejectionCategory clientRequest createdAt completedAt reviewedAt
      createdArtifacts { kind id } rationale { headline changes { what why } }`,
    shape: { clientId: clientId.optional(), limit: z.number().int().min(1).max(100).default(20) },
  });
  readTool(server, {
    name: "list_client_subscriptions",
    desc: "A client's plan subscriptions with you (current and past): plan, status, renewal status, period end and any pauses.",
    field: "subscriptionsForClient",
    args: "clientId: ID!, pagination: PaginationInput",
    select: SUBSCRIPTION,
    shape: {
      clientId,
      pagination: z.object({ pageNumber: z.number().int().min(1), pageSize: z.number().int().min(1).max(100) }).default({ pageNumber: 1, pageSize: 25 }),
    },
  });
  readTool(server, {
    name: "get_session",
    desc: "One booked session by id (from list_sessions): time, type, location or meeting link, status and notes.",
    field: "sessionById",
    args: "id: ID!",
    select: `_id clientId client { _id name } type status scheduledStart scheduledEnd meetingLink meetingProvider inAppVideo
      location { addressLine1 city country } notes { trainer client } subscriptionId`,
    shape: { id },
  });
  readTool(server, {
    name: "get_community_unread_count",
    desc: "Number of unread community posts across the coach's communities.",
    field: "communityUnreadTotal",
  });

  /* ── Exercise catalog ── */
  readTool(server, {
    name: "list_exercise_body_parts",
    desc: "Body-part names the exercise catalog is grouped by — valid values for browse_exercise_catalog's bodyPart.",
    field: "bodyParts",
  });
  readTool(server, {
    name: "list_exercise_equipment",
    desc: "Equipment names used in the exercise catalog — valid values for browse_exercise_catalog's equipment.",
    field: "catalogEquipment",
  });
  readTool(server, {
    name: "browse_exercise_catalog",
    desc: "Browse/filter the exercise catalog (platform + the coach's own custom exercises) by body part, equipment, discipline or text. Use search_exercises for a quick name lookup; this is for 'show me all dumbbell shoulder moves'. Page with page/pageSize until hasMore is false.",
    field: "catalogExercises",
    args: "filter: CatalogExerciseFilter, page: Int, pageSize: Int",
    select: `page pageSize hasMore items { ${CATALOG_EXERCISE} }`,
    shape: {
      filter: z
        .object({
          search: z.string().optional(),
          bodyPart: z.string().optional(),
          equipment: z.string().optional(),
          discipline: z.string().optional(),
          customOnly: z.boolean().optional().describe("Only the coach's own custom exercises"),
          bodyParts: z.array(z.string()).optional(),
          equipments: z.array(z.string()).optional(),
          disciplines: z.array(z.string()).optional(),
        })
        .optional(),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(30),
    },
  });
  writeTool(server, {
    name: "delete_custom_exercise",
    desc: "Delete one of the coach's own custom exercises (only items with custom: true and editable: true in browse_exercise_catalog). Existing plans keep their copy.",
    field: "deleteCoachExercise",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });

  /* ── Coupons ── */
  readTool(server, {
    name: "list_coupons",
    desc: "The coach's discount codes: code, % off, which plans it applies to (empty = all), redemptions vs limit, expiry and on/off.",
    field: "myCoupons",
    select: COUPON,
  });
  writeTool(server, {
    name: "create_coupon",
    desc: "Create a % discount code clients enter at checkout. code: 3-24 letters/numbers/-/_ (unique per coach). percentOff 1-99. planIds empty = every plan (ids from list_my_plans). expiresAt must be in the future.",
    field: "createCoupon",
    args: "input: CreateCouponInput!",
    select: COUPON,
    shape: {
      input: z.object({
        code: z.string().regex(/^[A-Za-z0-9_-]{3,24}$/, "3-24 letters, numbers, - or _"),
        percentOff: z.number().int().min(1).max(99),
        planIds: z.array(id).max(50).optional(),
        maxRedemptions: z.number().int().min(1).max(100000).optional(),
        expiresAt: z.string().optional().describe("ISO date/time, e.g. 2026-12-31T23:59:59+05:30"),
      }),
    },
  });
  writeTool(server, {
    name: "set_coupon_active",
    desc: "Turn a discount code on or off (codes are never deleted, only switched off).",
    field: "setCouponActive",
    args: "id: ID!, isActive: Boolean!",
    select: "id code isActive",
    shape: { id, isActive: z.boolean() },
  });

  /* ── Challenges ── */
  readTool(server, {
    name: "list_challenges",
    desc: "The coach's (or gym's) workout challenges: dates, phase (UPCOMING/ACTIVE/ENDED), on/off and participant count. A challenge ranks clients by the number of days they logged a workout.",
    field: "coachChallenges",
    select: CHALLENGE,
  });
  readTool(server, {
    name: "get_challenge_leaderboard",
    desc: "Ranking for one challenge: each participant's rank and workout days logged in the window.",
    field: "coachChallengeLeaderboard",
    args: "challengeId: ID!",
    select: "rank userId fullName days",
    shape: { challengeId: id },
  });
  writeTool(server, {
    name: "create_challenge",
    desc: "Start a workout-days challenge for your clients (most days with a logged workout wins). Dates YYYY-MM-DD, end on/after start and not in the past; the server caps length and how many run at once. forWholeGym: gym owners only — includes every gym member.",
    field: "createChallenge",
    args: "input: CreateChallengeInput!",
    select: CHALLENGE,
    shape: {
      input: z.object({
        title: z.string().min(3).max(120),
        description: z.string().max(2000).optional(),
        startDate: dayKey,
        endDate: dayKey,
        forWholeGym: z.boolean().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "set_challenge_active",
    desc: "Pause (hide from clients) or re-enable a challenge.",
    field: "setChallengeActive",
    args: "id: ID!, isActive: Boolean!",
    select: "id title isActive phase",
    shape: { id, isActive: z.boolean() },
  });
  writeTool(server, {
    name: "delete_challenge",
    desc: "Permanently delete a challenge and its leaderboard. Prefer set_challenge_active false to just hide it.",
    field: "deleteChallenge",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });

  /* ── Workout section templates (reusable warm-ups, finishers, circuits) ── */
  readTool(server, {
    name: "list_workout_section_templates",
    desc: "Saved workout sections (e.g. a standard warm-up or finisher) the coach drops into plans. Optional name search.",
    field: "workoutSectionTemplates",
    args: "search: String",
    select: SECTION_TEMPLATE,
    shape: { search: z.string().optional() },
  });

  // Custom handlers (exercise normalisation), so register their docs for validate-docs by hand.
  const createDoc = buildDoc("mutation", { field: "createWorkoutSectionTemplate", args: "input: CreateWorkoutSectionTemplateInput!", select: SECTION_TEMPLATE });
  const updateDoc = buildDoc("mutation", { field: "updateWorkoutSectionTemplate", args: "id: ID!, input: UpdateWorkoutSectionTemplateInput!", select: SECTION_TEMPLATE });
  REGISTERED_DOCS.push({ tool: "create_workout_section_template", doc: createDoc }, { tool: "update_workout_section_template", doc: updateDoc });
  const section = z
    .enum(["WARMUP", "RESISTANCE", "STRETCHING", "CARDIO", "COOL_DOWN"])
    .describe("Which part of a workout this block fills; applied to every exercise in it");
  const withSection = (exs: Record<string, unknown>[], sec?: string) =>
    normalizeExercises(sec ? exs.map((e) => ({ ...e, section: sec })) : exs);

  server.tool(
    "create_workout_section_template",
    "Save a reusable workout section (warm-up, finisher, circuit) to drop into plans later. ownedByGym: share it with the whole gym (gym owners/admins). (confirm-gated: previews until confirm: true)",
    {
      name: z.string().min(1).max(120),
      section: section.optional(),
      exercises: exercisesArg,
      ownedByGym: z.boolean().optional(),
      ...confirmField,
    },
    WRITE,
    async ({ name, section: sec, exercises, ownedByGym, confirm }) => {
      const input = { name, section: sec, exercises: withSection(exercises, sec), ownedByGym };
      if (!confirm) return preview("create_workout_section_template", input);
      return guard(() => gql(createDoc, { input }));
    },
  );
  server.tool(
    "update_workout_section_template",
    "Rename a saved workout section or replace its exercises (exercises, when given, replaces the whole list). (confirm-gated: previews until confirm: true)",
    {
      id,
      name: z.string().min(1).max(120).optional(),
      section: section.optional(),
      exercises: exercisesArg.optional(),
      ...confirmField,
    },
    WRITE,
    async ({ id: templateId, name, section: sec, exercises, confirm }) => {
      const input: Record<string, unknown> = {};
      if (name !== undefined) input.name = name;
      if (sec !== undefined) input.section = sec;
      if (exercises) input.exercises = withSection(exercises, sec);
      if (!Object.keys(input).length) return guard(async () => { throw new Error("Nothing to change: pass name, section or exercises"); });
      if (!confirm) return preview("update_workout_section_template", { id: templateId, ...input });
      return guard(() => gql(updateDoc, { id: templateId, input }));
    },
  );
  writeTool(server, {
    name: "delete_workout_section_template",
    desc: "Delete a saved workout section. Plans that already used it keep their exercises.",
    field: "deleteWorkoutSectionTemplate",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });
}
