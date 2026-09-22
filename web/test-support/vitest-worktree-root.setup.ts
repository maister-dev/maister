import { mkdir } from "node:fs/promises";

import { afterAll, beforeEach } from "vitest";

import { invocationFromEnvironment, registerRoot } from "./process-invocation";
import {
  cleanupTestWorktrees,
  createTestWorktreesRoot,
} from "./worktree-test-root";

const invocationId = `${process.env.MAISTER_TEST_WORKTREE_INVOCATION_ID ?? "vitest"}-${process.pid}`;
const worktreesRoot = createTestWorktreesRoot("vitest", invocationId);
const originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
const originalCaseName = process.env.MAISTER_TEST_CASE_NAME;

beforeEach((context) => {
  process.env.MAISTER_TEST_CASE_NAME = context.task.name;
});

process.env.MAISTER_WORKTREES_ROOT = worktreesRoot;
const invocation = invocationFromEnvironment();

if (invocation) {
  await mkdir(worktreesRoot, { recursive: true });
  await registerRoot(invocation, worktreesRoot, "worktrees");
}

afterAll(async () => {
  try {
    await cleanupTestWorktrees(worktreesRoot);
  } finally {
    if (originalCaseName === undefined)
      delete process.env.MAISTER_TEST_CASE_NAME;
    else process.env.MAISTER_TEST_CASE_NAME = originalCaseName;
    if (originalWorktreesRoot === undefined) {
      delete process.env.MAISTER_WORKTREES_ROOT;
    } else {
      process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
    }
  }
});
