import { z } from "zod";

export const repositorySummarySchema = z.object({
  defaultBranch: z.string(),
  description: z.string().nullable(),
  forks: z.number().int().nonnegative(),
  fullName: z.string(),
  license: z.string(),
  openIssues: z.number().int().nonnegative(),
  pushedAt: z.string().datetime(),
  stars: z.number().int().nonnegative(),
  url: z.string().url(),
});

export type RepositorySummary = z.infer<typeof repositorySummarySchema>;
