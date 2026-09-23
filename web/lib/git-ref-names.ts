import { z } from "zod";

// THE branch-name rule for every git/PR sink (worktree argv, gh/glab, the Gitea
// REST body) and for the public-branch template. Client-safe on purpose: the
// maister.yaml schema validates templates in client bundles too.
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "branch must match /^[A-Za-z0-9_./-]+$/")
  .refine((b) => !b.startsWith("-"), "branch must not start with '-'")
  .refine((b) => !b.includes(".."), "branch must not contain '..'")
  .refine((b) => !b.includes("@{"), "branch must not contain '@{'")
  .refine((b) => !b.endsWith("/"), "branch must not end with '/'")
  .refine((b) => !b.endsWith(".lock"), "branch must not end with .lock");
