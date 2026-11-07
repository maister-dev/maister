import { z } from "zod";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { MaisterError } from "@/lib/errors-core";
import { postgresTextSchema } from "@/lib/text-schema";

/** A server-recorded review witnesses current approval, never historical authorship or enduring permission. */
export const projectSourceReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewerUserId: postgresTextSchema.min(1).max(128),
    reviewedAt: z.iso.datetime(),
    sourceRevision: knowledgeRevisionSchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ProjectSourceReview = z.infer<typeof projectSourceReviewSchema>;

export function parseProjectSourceReview(
  value: unknown,
): ProjectSourceReview | null {
  if (value === null || value === undefined) return null;
  const parsed = projectSourceReviewSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Project source review has invalid or unsupported metadata",
    );

  return parsed.data;
}
