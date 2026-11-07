import type { Db } from "@/lib/execution-host/db";

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { projects, tasks } from "@/lib/db/schema";
import { loadTaskQualificationInput } from "@/lib/tasks/qualification";
import { git, initRepo } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { seedAcceptedQualificationFixture } from "@/test-support/accepted-qualification";

/** Real repository-backed engine fixtures satisfy admission without claiming a model produced the assessment. */
export async function seedAcceptedRepositoryQualification(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<void> {
  const input = await loadTaskQualificationInput(db, projectId, taskId);
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project)
    throw new Error("Repository qualification fixture requires its project");
  const sha = await git(
    project.repoPath,
    "rev-parse",
    "--verify",
    `${input.target}^{commit}`,
  );

  await seedAcceptedQualificationFixture(db, projectId, taskId, {
    target: input.target,
    sha,
    identity: "repository-engine-fixture",
    rationale:
      "Engine fixture pins the existing repository revision; no model assessment is claimed.",
    reference: `${input.target}@${sha}:engine-fixture`,
  });
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));

  if (task.triageStatus !== "flagged")
    await db
      .update(tasks)
      .set({ triageStatus: "triaged", launchMode: "auto" })
      .where(eq(tasks.id, taskId));
}

/** Caller owns removal of this real temporary repository after the engine assertions finish. */
export async function createEngineFixtureRepository(): Promise<string> {
  const repo = await initRepo(await mkdtempReal("engine-admission-repo-"));

  await mkdir(path.join(repo, ".fixture-flow"));

  return repo;
}

/** Real checkout/capture effects stay within an owned temporary root for the entire consumer suite. */
export async function isolateEngineFixtureFilesystem(): Promise<
  () => Promise<void>
> {
  const root = await mkdtempReal("engine-admission-runtime-");
  const previousRuntime = process.env.MAISTER_RUNTIME_ROOT;
  const previousWorktrees = process.env.MAISTER_WORKTREES_ROOT;

  process.env.MAISTER_RUNTIME_ROOT = root;
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");

  return async () => {
    if (previousRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = previousRuntime;
    if (previousWorktrees === undefined)
      delete process.env.MAISTER_WORKTREES_ROOT;
    else process.env.MAISTER_WORKTREES_ROOT = previousWorktrees;
    await rm(root, { recursive: true, force: true });
  };
}

/** Independent technical cases retain bound Runs for inspection; capacity suites use their own configuration. */
export async function isolateEngineFixtureRuntime(): Promise<
  () => Promise<void>
> {
  const restoreFilesystem = await isolateEngineFixtureFilesystem();
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  process.env.MAISTER_MAX_CONCURRENT_RUNS = "64";

  return async () => {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
    await restoreFilesystem();
  };
}
