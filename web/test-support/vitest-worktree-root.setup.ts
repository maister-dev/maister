import { afterAll } from "vitest";

import {
  cleanupTestWorktrees,
  createTestWorktreesRoot,
} from "./worktree-test-root";

const invocationId = `${process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID ?? "vitest"}-${process.pid}`;
const worktreesRoot = createTestWorktreesRoot("vitest", invocationId);
const originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;

process.env.MAISTER_WORKTREES_ROOT = worktreesRoot;

afterAll(async () => {
  try {
    await cleanupTestWorktrees(worktreesRoot);
  } finally {
    if (originalWorktreesRoot === undefined) {
      delete process.env.MAISTER_WORKTREES_ROOT;
    } else {
      process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
    }
  }
});
