import { z } from "zod";

import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { MaisterError } from "@/lib/errors-core";
import { postgresTextSchema } from "@/lib/text-schema";

/** A server-recorded review witnesses current approval, never historical authorship or enduring permission. */
const legacyProjectSourceReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    reviewerUserId: postgresTextSchema.min(1).max(128),
    reviewedAt: z.iso.datetime(),
    sourceRevision: knowledgeRevisionSchema,
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const projectEventCursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
    "Event cursor exceeds PostgreSQL bigint identity range",
  );
export const projectEventSourceReviewSchema = legacyProjectSourceReviewSchema
  .extend({
    schemaVersion: z.literal(2),
    eventCursor: projectEventCursorSchema,
    sourceSharing: z.enum(["none", "producing_run"]),
  })
  .strict();
export const projectSourceReviewSchema = z.union([
  legacyProjectSourceReviewSchema,
  projectEventSourceReviewSchema,
]);

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
