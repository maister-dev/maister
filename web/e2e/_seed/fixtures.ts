import { readFileSync } from "node:fs";
import path from "node:path";

export type E2EUserFixture = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export type E2EProjectFixture = {
  projectId: string;
  projectSlug: string;
  repoPath: string;
  executorId: string;
  flowId: string;
  taskId?: string;
  runId?: string;
  hitlRequestId?: string;
  worktreePath?: string;
  branch?: string;
};

export type E2ERegistrationFixture = {
  repoPath: string;
  duplicateRepoPath: string;
  expectedSlug: string;
  duplicateSlug: string;
};

export type E2EFixtures = {
  adminEmail: string;
  adminPassword: string;
  runId: string;
  hitlRequestId: string;
  projectSlug: string;
  branch: string;
  users: {
    admin: E2EUserFixture;
    mustChange: E2EUserFixture;
    pending: E2EUserFixture;
    disabled: E2EUserFixture;
    member: E2EUserFixture;
    editTarget: E2EUserFixture;
  };
  byKey: {
    m11a: E2EProjectFixture;
    m11b: E2EProjectFixture;
    board: E2EProjectFixture;
    scratch: E2EProjectFixture;
    liveCcr: E2EProjectFixture;
    registration: E2ERegistrationFixture;
  };
};

export function loadFixtures(): E2EFixtures {
  return JSON.parse(
    readFileSync(path.resolve("e2e/.auth/fixtures.json"), "utf8"),
  ) as E2EFixtures;
}
