import type { Db } from "@/lib/execution-host/db";
import type { RunResultContract } from "@/lib/run-results/types";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import {
  agentProjectLinks,
  agents,
  packageInstalls,
  platformAcpRunners,
  projectPackageAttachments,
  projects,
  runSessions,
  runs,
  workspaces,
} from "@/lib/db/schema";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { localHost } from "@/lib/execution-host/resolver";
import { addWorktree } from "@/lib/worktree";
import { git, initRepo } from "@/test-support/git-fixture";

export type SeedAgentRunInput = Readonly<{
  /** The real supervisor's runtime root: the package and repo live under it. */
  runtimeRoot: string;
  /** The full `<stem>.md` definition — frontmatter and prompt. */
  definition: string;
  workspace: "none" | "worktree";
  resultContract: RunResultContract | null;
  persistent?: boolean;
}>;

/** A platform agent run the production launcher can start: package, project,
 * attachment, runner, `Running` run, its logical session and a `launch`
 * assignment. A `worktree` agent also gets its worktree and `workspaces` row —
 * the only workspace axis whose permission requests reach the web, since
 * read-only sessions are arbitrated inline by the host.
 */
export async function seedAgentRun(
  db: Db,
  input: SeedAgentRunInput,
): Promise<string> {
  const runId = randomUUID();
  const projectId = randomUUID();
  const runnerId = randomUUID();
  const packageId = randomUUID();
  const packageName = `fixture-${runId}`;
  const agentId = `${packageName}:researcher`;
  const repoPath = await initRepo(
    path.join(input.runtimeRoot, `repo-${runId}`),
  );
  const installedPath = path.join(input.runtimeRoot, `package-${runId}`);
  const sourcePath = path.join(
    installedPath,
    "maister-agents",
    "researcher.md",
  );

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, input.definition);
  await db.insert(projects).values({
    id: projectId,
    slug: `p-${runId}`,
    name: "Agent fixture",
    taskKey: `T${runId.replaceAll("-", "").slice(0, 7)}`.toUpperCase(),
    repoPath,
    maisterYamlPath: path.join(repoPath, "maister.yaml"),
  });
  await db.insert(packageInstalls).values({
    id: packageId,
    sourceUrl: `github.com/fixture/${runId}`,
    name: packageName,
    versionLabel: "v1.0.0",
    resolvedRevision: "rev-1",
    manifest: {},
    manifestDigest: "digest",
    installedPath,
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
  await db.insert(projectPackageAttachments).values({
    id: randomUUID(),
    projectId,
    packageInstallId: packageId,
    packageName,
  });
  await db.insert(agents).values({
    id: agentId,
    packageName,
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Researcher",
    description: "d",
    workspace: input.workspace,
    mode: "session",
    triggers: ["manual"],
    riskTier: "read_only",
    sourcePath,
    enabled: true,
  });
  await db
    .insert(agentProjectLinks)
    .values({ id: randomUUID(), projectId, agentId });
  const snapshot = testRunnerSnapshot(runnerId);

  await db.insert(platformAcpRunners).values({
    id: runnerId,
    adapter: "claude",
    capabilityAgent: "claude",
    model: snapshot.model,
    provider: { kind: "anthropic" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  await db.insert(runs).values({
    id: runId,
    projectId,
    runKind: "agent",
    agentId,
    agentWorkspace: input.workspace,
    status: "Running",
    flowVersion: "agent",
    flowRevision: "manual",
    resultContract: input.resultContract,
    triggerSource: "manual",
    persistent: input.persistent ?? false,
    addressableKey: input.persistent ? "researcher" : null,
  });
  if (input.workspace === "worktree") {
    const worktreePath = agentWorkdirPath(`p-${runId}`, runId);
    const branch = `maister/permission-${runId}`;
    const baseCommit = await git(repoPath, "rev-parse", "HEAD");

    await addWorktree({
      projectRepoPath: repoPath,
      worktreePath,
      branch,
      startPoint: "main",
      provenance: {
        version: 2,
        runId,
        parentRepoPath: repoPath,
        projectId,
        branch,
        workspaceKind: "agent",
        createdAt: new Date().toISOString(),
      },
    });
    await db.insert(workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch,
      worktreePath,
      parentRepoPath: repoPath,
      baseBranch: "main",
      targetBranch: "main",
      baseCommit,
    });
  }
  await db.insert(runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId,
    runnerSnapshot: snapshot,
    capabilityAgent: "claude",
  });
  const hosts = createExecutionHosts({ db });
  const host = await localHost({ db, transport: hosts.transport });

  await db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId: host.id, reason: "launch" }),
  );

  return runId;
}
