/**
 * Guards create_workout_plan/create_diet_plan against being re-run for a
 * client conversation that already got its plan. Observed live: a coach
 * asked "is it done?" twice after a plan was confirmed, and each follow-up
 * produced another near-identical plan for the same client rather than a
 * status check — three workout plans and two diet plans within ~90 seconds.
 *
 * Kept as a standalone module (rather than inline in index.ts, where the
 * create tools live) purely so the matching rule is unit-testable without
 * pulling in the MCP server or a live GraphQL call.
 */

export const RECENT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type RecentPlan = { _id: string; title: string; createdAt: string };

/**
 * Returns the most recent plan in `plans` whose title matches `title`
 * (case/whitespace-insensitive) and was created within the last
 * `windowMs` of `now`, or null if there is no such plan.
 */
export function pickRecentDuplicate(
  plans: RecentPlan[],
  title: string,
  now: number,
  windowMs: number = RECENT_DUPLICATE_WINDOW_MS,
): RecentPlan | null {
  const normalizedTitle = title.trim().toLowerCase();

  const candidates = plans.filter((plan) => {
    if (plan.title.trim().toLowerCase() !== normalizedTitle) return false;
    const age = now - new Date(plan.createdAt).getTime();
    return age >= 0 && age < windowMs;
  });
  if (!candidates.length) return null;

  // Most recent first, in case more than one slipped through before this
  // guard existed.
  candidates.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return candidates[0];
}
