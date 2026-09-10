import { z } from "zod";

const explanation = z.string().trim().min(1).max(2_000);

/** A pass cannot carry unresolved deviations; a rejection must be actionable. */
export const ReplyGoalReviewSchema = z
  .object({
    goalAchieved: z.boolean(),
    explanation,
    deviations: z.array(z.string().trim().min(1).max(1_000)).max(8),
    revisionInstructions: z.string().trim().max(4_000),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.goalAchieved
        ? review.deviations.length !== 0 || review.revisionInstructions !== ""
        : review.deviations.length === 0 || review.revisionInstructions === ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A pass has no unresolved deviations or revision instructions; a failure requires both.",
      });
    }
  });
export type ReplyGoalReview = z.infer<typeof ReplyGoalReviewSchema>;

/** This operation has no channel through which it can propose world effects. */
export const ReplyGoalRewriteSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();
