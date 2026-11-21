import { z } from "zod";

import { branchNameViolation } from "../../runtime/git-branch";

// THE branch-name rule for every git/PR sink (worktree argv, gh/glab, the Gitea
// REST body) and for the public-branch template. Client-safe on purpose: the
// maister.yaml schema validates templates in client bundles too. It refuses
// every name `git check-ref-format --branch` refuses (within the character set
// below), since an operator types the public name (ADR-181 D4) and a name git
// refuses would fail only at the push.
export const branchNameSchema = z.string().superRefine((value, ctx) => {
  const violation = branchNameViolation(value);

  if (violation) ctx.addIssue({ code: "custom", message: violation });
});
