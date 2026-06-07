/**
 * Coach calculators — pure, offline. Ported from the apps' HealthMath /
 * WorkoutMath so the assistant can compute without a network call.
 */

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  SEDENTARY: 1.2,
  LIGHT: 1.375,
  MODERATE: 1.55,
  ACTIVE: 1.725,
  VERY_ACTIVE: 1.9,
};

export function computeBmr(
  gender: "MALE" | "FEMALE",
  weightKg: number,
  heightCm: number,
  age: number,
  bodyFatPct?: number
): number {
  if (bodyFatPct && bodyFatPct > 0) {
    const lbm = weightKg * (1 - bodyFatPct / 100);
    return Math.round(370 + 21.6 * lbm); // Katch-McArdle
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(base + (gender === "MALE" ? 5 : -161)); // Mifflin-St Jeor
}

export function computeTdee(bmr: number, activity: string): number {
  return Math.round(bmr * (ACTIVITY_MULTIPLIERS[activity] ?? 1.2));
}

export function recommendedCalories(goal: "LOSE_FAT" | "MAINTAIN" | "GAIN_MUSCLE", tdee: number): number {
  const adj = goal === "LOSE_FAT" ? -400 : goal === "GAIN_MUSCLE" ? 250 : 0;
  return Math.max(1200, Math.round(tdee + adj));
}

export type MacroStrategy = "STANDARD" | "PRO" | "KETO";

export function calculateMacros(
  strategy: MacroStrategy,
  totalCalories: number,
  weightKg: number,
  proProteinGKg = 2.2,
  proFatGKg = 0.8
): { protein: number; carbs: number; fat: number } {
  const cals = Math.max(0, totalCalories);
  if (strategy === "PRO") {
    const protein = Math.round(weightKg * proProteinGKg);
    const fat = Math.round(weightKg * proFatGKg);
    const remaining = Math.max(0, cals - protein * 4 - fat * 9);
    return { protein, carbs: Math.round(remaining / 4), fat };
  }
  if (strategy === "KETO") {
    return {
      protein: Math.round((cals * 0.25) / 4),
      carbs: Math.round((cals * 0.05) / 4),
      fat: Math.round((cals * 0.7) / 9),
    };
  }
  // STANDARD 40/30/30
  return {
    protein: Math.round((cals * 0.4) / 4),
    carbs: Math.round((cals * 0.3) / 4),
    fat: Math.round((cals * 0.3) / 9),
  };
}

export function computeOneRm(weightKg: number, reps: number): number {
  if (weightKg <= 0 || reps <= 0) return 0;
  if (reps === 1) return Math.round(weightKg);
  return Math.round(weightKg * (1 + reps / 30)); // Epley
}

export function weightSuggestions(oneRmKg: number) {
  if (oneRmKg <= 0) return [];
  const at = (p: number) => Math.round((oneRmKg * p) / 100);
  return [
    { label: "Endurance", pct: 60, weightKg: at(60), reps: "15-20" },
    { label: "Hypertrophy", pct: 75, weightKg: at(75), reps: "8-12" },
    { label: "Strength", pct: 85, weightKg: at(85), reps: "3-5" },
    { label: "Peak Effort", pct: 95, weightKg: at(95), reps: "1-2" },
  ];
}
