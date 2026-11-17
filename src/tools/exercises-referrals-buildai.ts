import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const organizationId = id.describe("Gym/organization _id (from list_my_organizations)");

const EXERCISE = "id name bodyPart equipment videoUrl imageKey notes ownedByGym editable createdAt updatedAt";
const SAMPLE = "hasSampleClients sampleClientCount canLoadSampleClients";
const MARKET = "_id isMarketplace price currency";
const JOB = `id kind status clientId artifactIds summary error priceCredits chargedCredits createdAt
  questions { type label required }
  formSteps { title description questions { type label helpText required options } }`;

const exerciseInput = z.object({
  name: z.string().min(1),
  bodyPart: z.string().min(1).describe("A body part from list_exercise_body_parts"),
  equipment: z.string().optional().describe("From list_exercise_equipment; defaults to bodyweight"),
  videoUrl: z.string().url().optional().describe("YouTube / web link to a demonstration"),
  imageKey: z.string().optional().describe("S3 key of an uploaded image (see upload_file). Omit on update to keep the current image."),
  notes: z.string().optional(),
});

/**
 * Remaining web-app gaps (Nov 17): custom exercises, plan-level marketplace, sample clients, referrals, gym lookups,
 * video-minute pack prices and Build with AI. (Group-assignment edits live next to the assign_* tools in index.ts.)
 */
export function registerExercisesReferralsBuildAiTools(server: McpServer): void {
  /* ── Custom exercises (delete_custom_exercise already exists) ── */
  readTool(server, {
    name: "list_my_custom_exercises",
    desc: "The coach's own custom exercises (name, body part, equipment, video link, whether the coach can edit it). Gym-shared ones show ownedByGym: true.",
    field: "myCoachExercises",
    select: EXERCISE,
  });
  writeTool(server, {
    name: "create_custom_exercise",
    desc: "Add a custom exercise to the coach's library so it can be used in plans. Use list_exercise_body_parts / list_exercise_equipment for valid values. ownedByGym: true puts it in the gym's shared library (gym owner/admin only).",
    field: "createCoachExercise",
    args: "input: CoachExerciseInput!",
    select: EXERCISE,
    shape: { input: exerciseInput.extend({ ownedByGym: z.boolean().optional() }) },
  });
  writeTool(server, {
    name: "update_custom_exercise",
    desc: "Edit one of the coach's custom exercises (only items with editable: true). Send the full set of fields; removeImage: true drops the current image.",
    field: "updateCoachExercise",
    args: "id: ID!, input: CoachExerciseInput!",
    select: EXERCISE,
    shape: { id, input: exerciseInput.extend({ removeImage: z.boolean().optional() }) },
  });

  /* ── Plan-level marketplace (the *_template_marketplace tools cover templates) ── */
  writeTool(server, {
    name: "set_diet_plan_marketplace",
    desc: "List or unlist an existing diet plan on the Trainzilla marketplace and set its price (whole currency units; usdPrice for international buyers). No payment is processed — it only makes the plan buyable.",
    field: "setDietPlanMarketplace",
    args: "planId: ID!, isMarketplace: Boolean!, price: Int, currency: String, usdPrice: Int",
    select: MARKET,
    shape: {
      planId: id,
      isMarketplace: z.boolean(),
      price: z.number().int().min(0).optional(),
      currency: z.string().optional(),
      usdPrice: z.number().int().min(0).optional(),
    },
  });
  writeTool(server, {
    name: "set_workout_plan_marketplace",
    desc: "List or unlist an existing workout plan on the Trainzilla marketplace and set its price (whole currency units; usdPrice for international buyers). No payment is processed — it only makes the plan buyable.",
    field: "setWorkoutPlanMarketplace",
    args: "planId: ID!, isMarketplace: Boolean!, price: Int, currency: String, usdPrice: Int",
    select: MARKET,
    shape: {
      planId: id,
      isMarketplace: z.boolean(),
      price: z.number().int().min(0).optional(),
      currency: z.string().optional(),
      usdPrice: z.number().int().min(0).optional(),
    },
  });

  /* ── Sample clients ── */
  readTool(server, {
    name: "get_sample_clients_status",
    desc: "Whether the coach has demo (sample) clients loaded, how many, and whether they can load some (solo coaches only, not inside a gym).",
    field: "sampleClientsStatus",
    select: SAMPLE,
  });
  writeTool(server, {
    name: "load_sample_clients",
    desc: "Add a set of demo clients with example data so the coach can explore the app. Only for solo coaches with none loaded (check get_sample_clients_status).",
    field: "loadSampleClients",
    select: SAMPLE,
  });
  writeTool(server, {
    name: "remove_sample_clients",
    desc: "Remove the demo (sample) clients and their example data. Real clients are not touched.",
    field: "removeSampleClients",
    select: SAMPLE,
    destructive: true,
  });

  /* ── Referrals ── */
  readTool(server, {
    name: "get_my_referred_by",
    desc: "Who referred this coach, and the welcome Pro months they were granted (null if they were not referred).",
    field: "myReferredBy",
    select: "kind referrerName referrerOrganizationName welcomeMonths welcomeGranted welcomeSkippedReason welcomeProUntil",
  });
  readTool(server, {
    name: "lookup_referral_code",
    desc: "Check a referral code: is it valid, who owns it, and how many free Pro months a referred coach gets.",
    field: "referralCodeLookup",
    args: "code: String!",
    select: "code valid kind referrerName referrerOrganizationName referredProMonths",
    shape: { code: z.string().min(1) },
  });
  writeTool(server, {
    name: "claim_gym_owner_referral",
    desc: "Apply a gym-owner referral code to this account (one-time; check it first with lookup_referral_code). Returns true if it was applied.",
    field: "claimGymOwnerReferral",
    args: "code: String!",
    shape: { code: z.string().min(1) },
  });

  /* ── Gym lookups & video minute packs ── */
  readTool(server, {
    name: "get_my_gym_checkin_code",
    desc: "The staff member's own rotating check-in code for the gym (and when it expires), used by the front-desk/kiosk flow.",
    field: "myGymCheckinCode",
    args: "organizationId: ID!",
    select: "code expiresAt",
    shape: { organizationId },
  });
  readTool(server, {
    name: "lookup_gym_member",
    desc: "Find a gym member by name or phone digits (phone shown masked, last 4 only), with whether their membership is active and when it ends. Use the clientId with other tools.",
    field: "organizationMemberLookup",
    args: "organizationId: ID!, query: String!, limit: Int",
    select: "clientId name phoneMasked membership membershipEndsAt",
    shape: { organizationId, query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
  });
  readTool(server, {
    name: "list_video_minute_packs",
    desc: "The video-call minute packs a coach can buy (minutes and INR/USD price). Read-only — purchasing happens in the app.",
    field: "videoMinutePacks",
    select: "id minutes label prices { INR USD }",
  });

  /* ── Build with AI (Coach Pro; costs AI credits) ── */
  readTool(server, {
    name: "get_build_with_ai_status",
    desc: "Whether the coach can use Build with AI (Coach Pro), their remaining AI credits, and the credit price of each build kind.",
    field: "buildWithAiStatus",
    select: "isPro remainingCredits prices { kind credits }",
  });
  readTool(server, {
    name: "get_ai_build_job",
    desc: "Status and result of a Build with AI job: created template/habit/program ids, check-in questions or onboarding form steps, summary, error and credits charged. Poll until status is no longer pending.",
    field: "aiBuildJob",
    args: "id: ID!",
    select: JOB,
    shape: { id },
  });
  writeTool(server, {
    name: "start_build_with_ai",
    desc: "Start an AI build (Coach Pro, spends AI credits, charged only if something is built): WORKOUT_TEMPLATE, DIET_TEMPLATE, CLIENT_WORKOUT_PLAN / CLIENT_DIET_PLAN (need clientId; loaded into an unsaved builder, not assigned), HABITS, CHECKIN_QUESTIONS, PROGRAM (no client is enrolled) or ONBOARDING_FORM (returned as data; the live form is unchanged). Check get_build_with_ai_status for the price first, then poll get_ai_build_job.",
    field: "startBuildWithAi",
    args: "input: AIBuildInput!",
    select: JOB,
    shape: {
      input: z.object({
        kind: z.enum(["WORKOUT_TEMPLATE", "DIET_TEMPLATE", "CLIENT_WORKOUT_PLAN", "CLIENT_DIET_PLAN", "HABITS", "CHECKIN_QUESTIONS", "PROGRAM", "ONBOARDING_FORM"]),
        clientId: id.optional().describe("Required for CLIENT_WORKOUT_PLAN / CLIENT_DIET_PLAN (client User _id)"),
        goal: z.string().optional(),
        level: z.string().optional(),
        daysPerWeek: z.number().int().min(1).max(7).optional(),
        weeks: z.number().int().min(1).max(52).optional(),
        caloriesPerDay: z.number().int().min(500).max(10000).optional(),
        dietType: z.string().optional(),
        notes: z.string().optional(),
        language: z.string().optional(),
      }),
    },
  });
}
