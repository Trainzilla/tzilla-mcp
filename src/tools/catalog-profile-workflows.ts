import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const orgId = id.describe("Gym id (from list_my_organizations)");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Date as YYYY-MM-DD");

const WORKFLOW = `id name templateKey enabled trigger { type days } actions { type text via requireApproval }
  excludedClientIds runCount lastRunAt organizationId createdAt`;
const workflowInput = z.object({
  name: z.string().min(1).max(80),
  trigger: z.object({ type: z.string().min(1), days: z.number().int().min(1).max(365).optional() }),
  actions: z
    .array(
      z.object({
        type: z.enum(["send_message", "ai_message", "notify_coach"]),
        text: z.string().min(1).max(1000),
        via: z.enum(["chat", "push", "email"]).optional(),
        requireApproval: z.boolean().optional(),
      })
    )
    .min(1),
  enabled: z.boolean().optional(),
  excludedClientIds: z.array(id).optional().describe("Clients this workflow must skip"),
});

export function registerCatalogProfileWorkflowTools(server: McpServer): void {
  /* ── Workflows: edit/delete + gym-wide ── */
  writeTool(server, {
    name: "update_workflow",
    desc: "Edit one of the coach's workflows (name, trigger, actions, excluded clients). Replaces the whole definition — fetch it with list_workflows first and change only what's needed. Safety limits stay: 8am–9pm client-local, max 2 workflow messages per client per day.",
    field: "updateWorkflow",
    args: "id: ID!, input: WorkflowInput!",
    select: WORKFLOW,
    shape: { id, input: workflowInput },
  });
  writeTool(server, {
    name: "delete_workflow",
    desc: "Delete one of the coach's workflows (past runs stay in the history).",
    field: "deleteWorkflow",
    args: "id: ID!",
    shape: { id },
    destructive: true,
  });
  readTool(server, {
    name: "list_gym_workflows",
    desc: "Gym-wide workflows (apply to every member of the gym).",
    field: "gymWorkflows",
    args: "organizationId: ID!",
    select: WORKFLOW,
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "create_gym_workflow",
    desc: "Create a gym-wide workflow (needs the gym's workflow permission): either templateKey (see list_workflow_templates) or a full definition.",
    field: "createGymWorkflow",
    args: "organizationId: ID!, input: WorkflowInput!",
    select: WORKFLOW,
    shape: { organizationId: orgId, input: workflowInput },
  });
  writeTool(server, {
    name: "create_gym_workflow_from_template",
    desc: "Switch on a ready-made gym-wide workflow from the template catalog.",
    field: "createGymWorkflowFromTemplate",
    args: "organizationId: ID!, templateKey: String!",
    select: WORKFLOW,
    shape: { organizationId: orgId, templateKey: z.string().min(1) },
  });
  writeTool(server, {
    name: "update_gym_workflow",
    desc: "Edit a gym-wide workflow (replaces the whole definition).",
    field: "updateGymWorkflow",
    args: "organizationId: ID!, id: ID!, input: WorkflowInput!",
    select: WORKFLOW,
    shape: { organizationId: orgId, id, input: workflowInput },
  });
  writeTool(server, {
    name: "set_gym_workflow_enabled",
    desc: "Turn a gym-wide workflow on or off.",
    field: "setGymWorkflowEnabled",
    args: "organizationId: ID!, id: ID!, enabled: Boolean!",
    select: "id name enabled",
    shape: { organizationId: orgId, id, enabled: z.boolean() },
  });
  writeTool(server, {
    name: "delete_gym_workflow",
    desc: "Delete a gym-wide workflow.",
    field: "deleteGymWorkflow",
    args: "organizationId: ID!, id: ID!",
    shape: { organizationId: orgId, id },
    destructive: true,
  });

  /* ── Habits ── */
  writeTool(server, {
    name: "update_master_habit",
    desc: "Edit a master habit template (name, emoji, description, frequency, target, reminder, active). Already-assigned copies are not changed.",
    field: "updateMasterHabit",
    args: "input: UpdateMasterHabitInput!",
    select: "_id name emoji category frequency targetCount isActive",
    shape: {
      input: z.object({
        masterHabitId: id,
        name: z.string().optional(),
        emoji: z.string().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        frequency: z.string().optional(),
        targetCount: z.number().int().optional(),
        tracker: z.string().optional(),
        daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
        reminderTime: z.string().optional(),
        isActive: z.boolean().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "remove_client_habit",
    desc: "Remove a habit from a client (use ids from list_client_habits).",
    field: "removeHabitForClient",
    args: "habitId: ID!",
    shape: { habitId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "log_client_habit",
    desc: "Record a habit completion count for a client on a day, on their behalf.",
    field: "logHabit",
    args: "input: LogHabitInput!",
    select: "_id habitId clientId date completedCount",
    shape: { input: z.object({ habitId: id, clientId, date: day, completedCount: z.number().int().min(0) }) },
  });
  readTool(server, {
    name: "list_system_habit_templates",
    desc: "Built-in habit templates (water, steps, sleep…) a coach can start from, optionally by category.",
    field: "systemHabitTemplates",
    args: "category: String",
    select: "id slug title category inputType unit",
    shape: { category: z.string().optional() },
  });

  /* ── Sessions ── */
  writeTool(server, {
    name: "mark_session_no_show",
    desc: "Mark a booked 1:1 session as a no-show (may count against the client's session pack).",
    field: "markSessionNoShow",
    args: "input: MarkNoShowInput!",
    select: "_id status",
    shape: { input: z.object({ sessionId: id, reason: z.string().optional() }) },
  });
  writeTool(server, {
    name: "update_session_client_notes",
    desc: "Set the notes the client sees on a session.",
    field: "updateSessionClientNotes",
    args: "input: UpdateSessionClientNotesInput!",
    select: "_id status",
    shape: { input: z.object({ sessionId: id, notes: z.string() }) },
  });

  /* ── PDF plans ── */
  readTool(server, {
    name: "get_plan_import",
    desc: "Status and result of a PDF plan import (PENDING → READY | FAILED), with the drafted workout days and meals to review.",
    field: "planImport",
    args: "id: ID!",
    select: `_id clientId status error workoutPlanIds dietPlanId createdAt document { fileName text }
      draft { workoutTitle dietTitle notes confidence workoutDays { title days exercises { name sets reps } } meals { name section scheduledTime days calories protein carbs fat } }`,
    shape: { id },
  });
  writeTool(server, {
    name: "convert_pdf_plan",
    desc: "Read the PDF behind a plan that was shared as-is into an editable draft (then poll get_plan_import).",
    field: "convertPdfPlan",
    args: "kind: PdfPlanKind!, planId: ID!",
    select: "_id status",
    shape: { kind: z.enum(["WORKOUT", "DIET"]), planId: id },
  });
  writeTool(server, {
    name: "share_pdf_plan_from_import",
    desc: "Assign the PDF of an existing import itself as the client's workout or diet plan (nothing to log). Uploading a new PDF is done in the app.",
    field: "sharePdfPlan",
    args: "input: SharePdfPlanInput!",
    select: "kind planId",
    shape: {
      input: z.object({
        clientId,
        kind: z.enum(["WORKOUT", "DIET"]),
        importId: id,
        title: z.string().min(1),
        description: z.string().optional(),
        startDate: day,
        endDate: day.optional(),
      }),
    },
  });
  writeTool(server, {
    name: "save_imported_plans",
    desc: "Create the reviewed plans from a READY PDF import: one workout plan per training day plus a diet plan. `workouts` and `diet` use the same shapes as create_workout_plan / create_diet_plan exercises and meals.",
    field: "saveImportedPlans",
    args: "input: SaveImportedPlansInput!",
    select: "workoutPlanIds dietPlanId",
    shape: {
      input: z.object({
        importId: id,
        startDate: day,
        endDate: day.optional(),
        workouts: z.array(z.record(z.unknown())).optional().describe("[{ title, description?, days?: [MONDAY..], exercises: [{ name, sets, reps, restSeconds, order, section? }] }]"),
        diet: z.record(z.unknown()).optional().describe("{ title, description?, meals: [{ name, scheduledTime, order, days, ingredients: [...] }] }"),
      }),
    },
  });

  /* ── Food, recipes, exercises ── */
  readTool(server, {
    name: "search_foods",
    desc: "Search the food database (page through with page/pageSize); use get_food_details for servings and nutrition.",
    field: "foodSearch",
    args: "query: String!, page: Int, pageSize: Int",
    select: "page pageSize totalResults hasMore items { id name type description imageUrl }",
    shape: { query: z.string().min(1), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20) },
  });
  readTool(server, {
    name: "get_food_details",
    desc: "A food's servings, allergens, dietary labels and nutrition.",
    field: "foodDetails",
    args: "foodId: ID!",
    select: "id name type brand description allergens dietaryLabels source servings { servingId servingDescription metricServingAmount metricServingUnit calories protein carbohydrate fat fiber sugar }",
    shape: { foodId: id },
  });
  readTool(server, {
    name: "lookup_food_barcode",
    desc: "Find a packaged food by barcode.",
    field: "foodByBarcode",
    args: "barcode: String!",
    select: "id name brand allergens dietaryLabels source servings { servingId servingDescription metricServingAmount metricServingUnit calories protein carbohydrate fat fiber sugar }",
    shape: { barcode: z.string().min(4) },
  });
  readTool(server, {
    name: "search_recipes",
    desc: "Search the recipe catalog by name, category or cuisine area.",
    field: "searchRecipes",
    args: "query: String, category: String, area: String, page: Int, pageSize: Int",
    select: "page pageSize hasMore items { id name category area }",
    shape: { query: z.string().optional(), category: z.string().optional(), area: z.string().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20) },
  });
  readTool(server, {
    name: "get_recipe",
    desc: "A recipe's ingredients, instructions, images and video.",
    field: "recipeDetail",
    args: "recipeId: ID!",
    select: "id name category area instructions imageUrls videoUrl ingredients { name measure }",
    shape: { recipeId: id },
  });
  readTool(server, {
    name: "get_exercise_detail",
    desc: "An exercise's description, steps, muscles, equipment, difficulty, images and video (by catalog id or name).",
    field: "exerciseDetail",
    args: "exerciseId: ID, name: String",
    select: "id name description steps bodyPart target equipment category difficulty disciplines imageUrls videoUrl",
    shape: { exerciseId: id.optional(), name: z.string().optional() },
  });
  readTool(server, {
    name: "get_exercise_alternatives",
    desc: "Substitute exercises for the same muscle/equipment.",
    field: "exerciseAlternatives",
    args: "exerciseId: ID!, limit: Int",
    select: "id name bodyPart target equipment videoUrl",
    shape: { exerciseId: id, limit: z.number().int().min(1).max(20).default(6) },
  });
  readTool(server, {
    name: "get_meal_alternatives",
    desc: "Swap candidates for one meal of a diet plan, with the calorie/macro difference.",
    field: "mealAlternatives",
    args: "planId: ID!, mealOrder: Int!, limit: Int",
    select: "meal { name calories } delta { calories protein carbs fat }",
    shape: { planId: id, mealOrder: z.number().int().min(1), limit: z.number().int().min(1).max(12).default(6) },
  });
  readTool(server, {
    name: "list_client_saved_meals",
    desc: "Meals a client saved for quick logging.",
    field: "savedMeals",
    args: "clientId: ID!",
    select: "id name calories useCount lastUsedAt macros { protein carbs fat }",
    shape: { clientId },
  });

  /* ── Coach profile: branding, domain, payout, calendar, video ── */
  readTool(server, {
    name: "get_my_branding",
    desc: "The coach's (or gym's) client-app branding: display name, logo, accent colour, on/off.",
    field: "myBranding",
    select: "displayName logoUrl enabled primaryColor",
  });
  writeTool(server, {
    name: "update_my_branding",
    desc: "Update client-app branding (Coach Pro only; gym coaches use the gym's branding). Logo/icon upload is done in the app.",
    field: "updateTrainerBranding",
    args: "input: UpdateTrainerBrandingInput!",
    select: "userId",
    shape: {
      input: z.object({
        branding: z.object({
          displayName: z.string().optional(),
          enabled: z.boolean().optional(),
          primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
          pageTemplate: z.string().optional().describe("Kinetic, Clean, Studio or Boutique"),
        }),
      }),
    },
  });
  const DOMAIN = "hostname status sslStatus failureReason cnameTarget ownershipTxtName ownershipTxtValue";
  readTool(server, {
    name: "get_my_custom_domain",
    desc: "The custom domain connected to the coach's public page (Coach Pro) and the DNS records still needed.",
    field: "myCustomDomain",
    select: DOMAIN,
  });
  writeTool(server, {
    name: "connect_my_custom_domain",
    desc: "Connect a custom domain to the coach's public page; returns the DNS records to add.",
    field: "connectCustomDomain",
    args: "hostname: String!",
    select: DOMAIN,
    shape: { hostname: z.string().min(3) },
  });
  writeTool(server, {
    name: "refresh_my_custom_domain",
    desc: "Re-check DNS/SSL status of the coach's custom domain.",
    field: "refreshCustomDomain",
    select: DOMAIN,
  });
  writeTool(server, {
    name: "remove_my_custom_domain",
    desc: "Disconnect the coach's custom domain.",
    field: "removeCustomDomain",
    destructive: true,
  });
  writeTool(server, {
    name: "update_my_global_payout",
    desc: "Set how the coach gets paid outside India: BANK (IBAN/SWIFT or account number), PAYPAL or WISE email. Sensitive — read the details back to the coach before confirming.",
    field: "updateTrainerGlobalPayout",
    args: "input: GlobalPayoutInput!",
    select: "userId",
    shape: {
      input: z.object({
        method: z.enum(["BANK", "PAYPAL", "WISE"]),
        accountHolderName: z.string().optional(),
        iban: z.string().optional(),
        accountNumber: z.string().optional(),
        swiftCode: z.string().optional(),
        bankName: z.string().optional(),
        bankCountry: z.string().optional(),
        email: z.string().email().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "update_my_localization",
    desc: "Set the coach's language, currency, units (metric/imperial), timezone and preferred weight unit.",
    field: "updateLocalization",
    args: "preferredLanguage: String, preferredCurrency: String, preferredUnits: String, timezone: String, preferredWeightUnit: String",
    select: "_id preferredLanguage preferredCurrency preferredUnits timezone preferredWeightUnit",
    shape: {
      preferredLanguage: z.string().optional(),
      preferredCurrency: z.string().length(3).optional(),
      preferredUnits: z.string().optional(),
      timezone: z.string().optional(),
      preferredWeightUnit: z.enum(["kg", "lbs"]).optional(),
    },
  });
  readTool(server, {
    name: "get_google_calendar_status",
    desc: "Whether the coach's Google Calendar is connected for session sync.",
    field: "googleCalendarStatus",
    select: "configured connected accountEmail needsReconnect",
  });
  writeTool(server, {
    name: "disconnect_google_calendar",
    desc: "Disconnect the coach's Google Calendar. (Connecting needs a browser sign-in; do it in the web app.)",
    field: "disconnectGoogleCalendar",
    destructive: true,
  });

  /* ── Video calls ── */
  readTool(server, {
    name: "get_video_call_access",
    desc: "Whether the coach can host video calls, and why not.",
    field: "videoCallAccess",
    select: "configured canHost reason",
  });
  readTool(server, {
    name: "get_video_minutes",
    desc: "Video-call minutes left this month (allowance + purchased) and when they reset.",
    field: "myVideoMinutes",
    select: "ownerType monthlyAllowanceMinutes monthlyUsedMinutes purchasedMinutesLeft minutesLeft resetsAt canBuy",
  });
  writeTool(server, {
    name: "start_instant_video_call",
    desc: "Start an instant video call with a client; returns the join URL and token for the coach's side and notifies the client.",
    field: "startInstantVideoCall",
    args: "clientId: ID!",
    select: "callId kind title roomName url token isHost expiresAt",
    shape: { clientId },
  });
  writeTool(server, {
    name: "join_session_video_call",
    desc: "Get the join URL/token for the video call of a booked 1:1 session.",
    field: "joinSessionVideoCall",
    args: "sessionId: ID!",
    select: "callId title url token isHost expiresAt",
    shape: { sessionId: id },
  });
  writeTool(server, {
    name: "join_gym_class_video_call",
    desc: "Get the join URL/token for a virtual gym class session.",
    field: "joinGymClassVideoCall",
    args: "gymClassSessionId: ID!",
    select: "callId title url token isHost expiresAt",
    shape: { gymClassSessionId: id },
  });
  writeTool(server, {
    name: "end_video_call",
    desc: "End a video call for everyone.",
    field: "endVideoCall",
    args: "callId: ID!",
    shape: { callId: id },
    destructive: true,
  });
}
