import { cleanupTestWorktrees } from "../test-support/worktree-test-root";

export default async function teardownE2eWorktrees(): Promise<void> {
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT;

  if (worktreesRoot !== undefined) {
    await cleanupTestWorktrees(worktreesRoot);
  }
}
