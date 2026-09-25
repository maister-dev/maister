import { z } from "zod";

// THE branch-name rule for every git/PR sink (worktree argv, gh/glab, the Gitea
// REST body) and for the public-branch template. Client-safe on purpose: the
// maister.yaml schema validates templates in client bundles too. It refuses
// every name `git check-ref-format --branch` refuses (within the character set
// below), since an operator types the public name (ADR-181 D4) and a name git
// refuses would fail only at the push.
export const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_./-]+$/, "branch must match /^[A-Za-z0-9_./-]+$/")
  .refine((b) => !b.startsWith("-"), "branch must not start with '-'")
  .refine((b) => !b.includes(".."), "branch must not contain '..'")
  .refine((b) => !b.includes("@{"), "branch must not contain '@{'")
  .refine(
    (b) => !b.startsWith("/") && !b.endsWith("/") && !b.includes("//"),
    "branch must not start or end with '/' or contain '//'",
  )
  .refine(
    (b) => !b.startsWith(".") && !b.includes("/."),
    "no branch name component may start with '.'",
  )
  .refine((b) => !b.endsWith("."), "branch must not end with '.'")
  .refine(
    (b) => !/\.lock(\/|$)/.test(b),
    "no branch name component may end with .lock",
  );
