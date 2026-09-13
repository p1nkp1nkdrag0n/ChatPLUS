import { z } from "zod";

/** Concise editorial findings, never hidden reasoning. Approval requires no
 * findings, and a rejection must identify at least one repairable issue. */
export const DiaryReviewSchema = z
  .strictObject({
    valid: z.boolean(),
    issues: z.array(z.string().trim().min(1).max(600)).max(8),
  })
  .refine((review) => review.valid === (review.issues.length === 0), {
    message: "valid must be true exactly when issues is empty",
    path: ["issues"],
  });
export type DiaryReview = z.infer<typeof DiaryReviewSchema>;
