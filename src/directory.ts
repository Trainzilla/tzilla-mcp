import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inferAnnotations, withAnnotations, type Annotations } from "./annotations.js";

/**
 * The "directory" profile: the version of the server submitted to public directories (Claude Connectors Directory,
 * ChatGPT apps). Differences from the full server:
 *  - a small curated tool set for a coach's day-to-day work (no credentials, payouts, checkout, org admin or health uploads);
 *  - descriptions only say what a tool does and what it returns. They never tell the model how to behave or which
 *    other tool to call (directory policy), so workflow guidance lives in the app's own assistant, not here;
 *  - stricter hints: tools that overwrite or send are marked destructive (OpenAI's rule), all are openWorldHint:false;
 *  - no prompts or resources, and a one-line server description instead of the long instructions.
 * The full server (every tool, rich descriptions) is unchanged and still served at /mcp.
 */

type Spec = { desc: string; destructive?: boolean };

const PREVIEW = "Returns a preview of the change; nothing is saved unless confirm is true.";

export const DIRECTORY_TOOLS: Record<string, Spec> = {
  // Account and clients
  whoami: { desc: "Returns the signed-in coach: user id, name, email, role and trainer id." },
  get_my_profile: { desc: "Returns the coach's own profile: contact details, professional info (specialties, certifications, bio), availability, and public testimonials. Bank details are not included." },
  list_clients: { desc: "Lists the coach's clients with id, name and email, a page at a time." },
  get_client_profile: { desc: "Returns a client's fitness profile and computed metrics: BMI, TDEE, recommended calories, and starting and latest logged weight." },
  get_client_preferences: { desc: "Returns a client's stated preferences: diet type, food allergies, cuisines, meals per day, cooking level, training days, home or gym, equipment, session length and notes." },
  get_client_roster: { desc: "Returns every client grouped into segments (needs programming, inactive, new, plan ending, on track) with last activity, 7 and 30 day workout adherence and days until the plan ends." },
  get_coach_dashboard_stats: { desc: "Returns the coach's dashboard numbers: active clients, revenue this month and last month in minor units, growth percentage, a 12-month revenue series, sessions this week and retention percentage." },
  get_coach_client_notes: { desc: "Returns the coach's private notes on one client as free text. Only the coach can see them; the client and other staff cannot." },
  set_coach_client_notes: { desc: `Replaces the coach's private notes on a client with the given text; an empty string clears them. ${PREVIEW}`, destructive: true },
  add_managed_client: { desc: `Adds a client who does not have the app, by name and optional WhatsApp number. Counts toward the coach's client limit. ${PREVIEW}` },
  send_invitation: { desc: `Emails a prospective client an invitation link to join Trainzilla under this coach. ${PREVIEW}`, destructive: true },

  // Check-ins
  list_checkins: { desc: "Lists check-ins, optionally for one client. A pending check-in whose scheduled time has passed means the client has not responded." },
  get_checkin: { desc: "Returns one check-in with its questions and status." },
  get_checkin_answers: { desc: "Returns a check-in's questions and the client's latest answers. Photo answers are returned as image URLs." },
  create_checkin: { desc: `Schedules a check-in for a client on a given date and time, with optional questions. A past date records a check-in that already happened without notifying the client. ${PREVIEW}` },
  schedule_checkin: { desc: `Sets a recurring weekly check-in for a client on a chosen day and time, with optional questions. Provide an existing schedule id to update it. ${PREVIEW}`, destructive: true },
  respond_to_checkin: { desc: `Accepts or rejects a pending check-in request. ${PREVIEW}`, destructive: true },

  // Habits
  list_client_habits: { desc: "Lists a client's active habits with today's log and current streaks." },
  get_habit_compliance: { desc: "Returns a client's habit compliance percentage (0 to 100) over a date range." },
  get_habit_adherence_all_clients: { desc: "Returns habit adherence percentage and best current streak for every client over a number of days." },
  recent_habit_activity: { desc: "Lists the most recent habit completions across all of the coach's clients, ordered newest to oldest." },
  create_habit: { desc: `Creates a habit for a client with a name, frequency, target, optional days of the week and reminder time. ${PREVIEW}` },
  update_habit: { desc: `Edits a client's habit: only the fields provided are changed. ${PREVIEW}`, destructive: true },

  // Workout plans and logs
  list_workout_plans: { desc: "Lists a client's workout plans with id, title and dates. Exercises are not included in the list." },
  get_workout_plan: { desc: "Returns one workout plan in full: every exercise with sets, reps, rest, section, supersets and notes, plus the source PDF text when the plan came from a PDF." },
  create_workout_plan: { desc: `Creates a workout plan for a client with a title, dates and exercises. ${PREVIEW}` },
  update_workout_plan: { desc: `Edits a workout plan: only the fields provided are changed, and a provided exercise list replaces the whole list. ${PREVIEW}`, destructive: true },
  delete_workout_plan: { desc: `Permanently deletes a workout plan; the client loses access to it. ${PREVIEW}`, destructive: true },
  get_client_workout_logs: { desc: "Returns the exercises a client logged on one day: sets, reps, weights, effort ratings, personal records and compliance." },
  get_client_personal_bests: { desc: "Returns a client's best weight and estimated one-rep max per exercise, ordered by most recent record." },
  get_exercise_history: { desc: "Returns the heaviest weight per session for one exercise of a client, as a progression curve." },
  get_client_workout_streak: { desc: "Returns a client's current and longest workout-day streak and the streak badges earned." },
  get_client_progress: { desc: "Returns a client's progress timeline: weight, body measurements, notes and photos with their source, optionally within a date range." },

  // Nutrition
  list_diet_plans: { desc: "Lists a client's diet plans with id, title and dates. Meals are not included in the list." },
  get_diet_plan: { desc: "Returns one diet plan in full: every meal with time, calories, macros, ingredients and notes, plus the source PDF text when the plan came from a PDF." },
  create_diet_plan: { desc: `Creates a diet plan for a client with a title, dates and meals; each meal lists its ingredients with quantities. ${PREVIEW}` },
  update_diet_plan: { desc: `Edits a diet plan: only the fields provided are changed, and a provided meal list replaces the whole list. ${PREVIEW}`, destructive: true },
  delete_diet_plan: { desc: `Permanently deletes a diet plan; the client loses access to it. ${PREVIEW}`, destructive: true },
  get_client_diet_logs: { desc: "Returns the meals a client logged on one day, with planned versus extra items, compliance and photos." },
  search_foods: { desc: "Searches the food database by name, a page at a time." },
  get_food_details: { desc: "Returns a food's servings, allergens, dietary labels and nutrition." },
  get_ingredient_nutrition: { desc: "Returns per-100g calories, protein, carbs and fat for raw ingredients matching a search, from the platform's nutrition table." },
  search_recipes: { desc: "Searches the recipe catalog by name, category or cuisine." },
  get_recipe: { desc: "Returns a recipe's ingredients, instructions, images and video." },

  // Exercises and calculators
  search_exercises: { desc: "Searches the exercise catalog by name and returns matching exercises with an id and a match confidence from 0 to 1." },
  get_exercise_detail: { desc: "Returns an exercise's description, steps, muscles, equipment, difficulty, images and video, by catalog id or name." },
  calc_tdee: { desc: "Computes BMR, TDEE and recommended daily calories from sex, weight, height, age, activity level, goal and optional body fat." },
  calc_macros: { desc: "Computes a protein, carbs and fat split in grams for a calorie target and strategy (standard 40/30/30, protein per kilogram, or keto)." },
  calc_1rm: { desc: "Estimates a one-rep max with the Epley formula from a working set, with percentage-of-max weight suggestions." },

  // Templates and programs
  list_workout_plan_templates: { desc: "Lists the coach's workout plan templates with id, title, tags, difficulty and goal." },
  get_workout_plan_template: { desc: "Returns one workout plan template in full, including every exercise." },
  create_workout_plan_template: { desc: `Saves a reusable workout plan template with title, tags, difficulty, goal and exercises. ${PREVIEW}` },
  list_diet_plan_templates: { desc: "Lists the coach's diet plan templates with id, title, tags, difficulty and goal." },
  get_diet_plan_template: { desc: "Returns one diet plan template in full, including every meal." },
  create_diet_plan_template: { desc: `Saves a reusable diet plan template with title, tags, difficulty, goal and meals; each meal lists its ingredients with quantities. ${PREVIEW}` },
  list_programs: { desc: "Lists the coach's programs with name, length in days, version and number of clients on each. Programs need Coach Pro or a gym plan." },
  get_program: { desc: "Returns one program with every item: type, day offset, time, repeat and payload." },

  // Sessions
  list_sessions: { desc: "Lists booked sessions for one client or for all of the coach's clients." },
  get_session: { desc: "Returns one booked session: time, type, location or meeting link, status and notes." },
  schedule_session: { desc: `Books a session for a client with a start and end time, an optional subscription to count against, and an optional meeting link. ${PREVIEW}` },
  reschedule_session: { desc: `Moves a session to a new start and end time; the client and coach are notified. ${PREVIEW}`, destructive: true },
  cancel_session: { desc: `Cancels a scheduled session with an optional reason shown to the client. ${PREVIEW}`, destructive: true },
  mark_session_done: { desc: `Marks one of the coach's sessions as completed so it counts toward the client's used sessions. ${PREVIEW}`, destructive: true },
  mark_session_no_show: { desc: `Marks a booked one-to-one session as a no-show, which may count against the client's session pack. ${PREVIEW}`, destructive: true },

  // Messages and groups
  send_message_to_client: { desc: `Sends a chat message to one of the coach's clients; it appears in the client's chat and triggers a push notification, as if the coach typed it. ${PREVIEW}`, destructive: true },
  list_client_groups: { desc: "Lists the coach's client groups with name and size. Groups need Coach Pro or a gym plan." },
  get_client_group: { desc: "Returns one client group with its members' ids and names." },
  create_client_group: { desc: `Creates a client group, optionally with starting members from the coach's own clients; names are unique per coach. ${PREVIEW}` },
  add_group_members: { desc: `Adds clients to a group, up to 200 per group; clients already in the group are left as they are. ${PREVIEW}` },

  // Payments (read-only)
  billing_summary: { desc: "Returns a summary of the coach's payments: total captured amount in minor units, currency and counts by status." },
  list_payments: { desc: "Lists payments received by the coach with amount, status, method, client and plan, ordered newest to oldest. Amounts are in minor units." },
};

const CONFIRM_DESC = "When true, performs the action. When false or omitted, returns a preview only.";

/** Words that tell the model what to do. Descriptions in this profile must not contain them. */
export const DIRECTIVE_WORDS = /\b(call|use|prefer|never|always|must|should|don't|do not|make sure|ensure|before|first|then|pass|try)\b/i;

/** Tool-name-looking tokens (snake_case with an underscore). */
const TOOL_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Drops any sentence that names another tool or tells the model what to do. */
export function scrubParamText(text: string): string {
  const parts = text
    .replace(/\s*\((?:[^()]*\b[a-z][a-z0-9]*_[a-z0-9_]+\b[^()]*)\)/gi, "") // "(from list_clients)"
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !TOOL_TOKEN.test(s) && !DIRECTIVE_WORDS.test(s));
  TOOL_TOKEN.lastIndex = 0;
  return parts.join(" ").trim();
}

function describeParam(schema: unknown, fallback?: string): unknown {
  const s = schema as { description?: string; describe?: (d: string) => unknown };
  const d = s?.description;
  if (!d) return schema;
  const clean = scrubParamText(d) || fallback || "";
  return clean ? (s.describe as (d: string) => unknown).call(s, clean) : schema;
}

/** Scrub every parameter description of a tool's input shape. */
export function scrubShape(shape: unknown): unknown {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) return shape;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape as Record<string, unknown>)) {
    out[k] = k === "confirm" ? (v as { describe: (d: string) => unknown }).describe(CONFIRM_DESC) : describeParam(v);
  }
  return out;
}

export const DIRECTORY_INSTRUCTIONS =
  "Trainzilla coaching tools for the signed-in coach's own account: clients, check-ins, habits, workout and diet plans, sessions and messages. Changes return a preview and are only applied when confirm is true.";

/**
 * Rewrite `server.tool(...)` registrations for the directory profile: skip tools that are not in the allowlist,
 * replace descriptions, scrub parameter text and set strict annotations. Prompts and resources are not registered.
 */
export function applyDirectoryProfile(server: McpServer): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = String(args[0]);
    const spec = DIRECTORY_TOOLS[name];
    if (!spec) return undefined; // not part of the directory profile
    // Normalised by withAnnotations to (name, [desc], shape, annotations, cb).
    const norm = withAnnotations(args);
    const cb = norm[norm.length - 1];
    const given = norm[norm.length - 2] as Annotations;
    const shape = norm[norm.length - 3];
    const writes = given.readOnlyHint === false;
    const ann: Annotations = writes
      ? { ...given, readOnlyHint: false, destructiveHint: Boolean(spec.destructive) }
      : { ...given, readOnlyHint: true };
    return original(name, spec.desc, scrubShape(shape), inferAnnotations(name, ann), cb);
  };
  const noop = () => undefined;
  (server as unknown as { prompt: () => undefined }).prompt = noop;
  (server as unknown as { resource: () => undefined }).resource = noop;
}
