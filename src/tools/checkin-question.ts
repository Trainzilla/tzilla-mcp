import { z } from "zod";

/** Body metrics a NUMBER check-in answer can record into the client's progress chart. */
export const CHECKIN_METRICS = ["WEIGHT", "WAIST", "HIP", "CHEST", "ARM", "THIGH", "NECK"] as const;

/** One check-in question, as every check-in tool takes it (one-off, recurring, group, program). */
export const checkInQuestionShape = z.object({
  id: z.string().optional().describe("Keep the id from a read when editing, so past answers keep matching"),
  type: z.enum(["TEXT", "NUMBER", "SCALE", "PHOTO", "YES_NO", "CHOICE"]),
  label: z.string().min(1),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1)).min(2).max(10).optional().describe("CHOICE only: the answers to pick from"),
  helpText: z.string().max(300).optional().describe("A line shown under the question, e.g. 'Weigh first thing in the morning'"),
  metric: z
    .enum(CHECKIN_METRICS)
    .optional()
    .describe(
      "NUMBER only: also save the answer to the client's progress chart as this metric. Read in the unit written in the label or answer ('Weight (lbs)', 'Waist (in)'), else the client's own unit setting.",
    ),
});

/** Fields to select when reading questions back. */
export const CHECKIN_QUESTION_FIELDS = "id type label required options helpText metric";
