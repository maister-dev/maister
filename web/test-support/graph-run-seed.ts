import type { FlowRevisionExecTrust } from "@/lib/db/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
  type TestRunnerAgent,
} from "@/lib/__tests__/runner-fixtures";

// FIXME(any): the graph-runner suites write seed rows through an untyped
// schema view because the typed insert builders reject the loose fixture
// literals. This is the single shared declaration of that cast.
export const schema = fullSchema as unknown as Record<string, any>;

export type SeedFlowRevisionOptions = {
  execTrust?: FlowRevisionExecTrust;
  resolvedRevision?: string;
  /** Also point flows.enabled_revision_id at the seeded revision. */
  enabledOnFlow?: boolean;
};

export type SeedWorkspaceOptions = {
  branch?: string;
  worktreePath?: string;
  parentRepoPath?: string;
  baseBranch?: string;
};

export type SeedGraphRunOptions = {
  flowRefId?: string;
  installedPath?: string;
  agent?: TestRunnerAgent;
  /** projects.repo_path; also the default workspaces.parent_repo_path. */
  repoPath?: string;
  /** Seed a flow_revisions row and set runs.flow_revision_id to it. */
  flowRevision?: boolean | SeedFlowRevisionOptions;
  /** Extra/override columns for the tasks row. */
  task?: Record<string, unknown>;
  /** Extra/override columns for the runs row. */
  run?: Record<string, unknown>;
  /** Legacy pre-M42 shape: runner triplet on the runs row, no run_sessions. */
  runnerOnRun?: boolean;
  /** false skips the workspaces row. */
  workspace?: false | SeedWorkspaceOptions;
};

export type SeededGraphRun = {
  projectId: string;
  slug: string;
  executorId: string;
  flowId: string;
  flowRevisionId: string | undefined;
  taskId: string;
  runId: string;
  worktreePath: string;
  runtimeRoot: string;
  repoPath: string;
};

/**
 * Seeds the relational spine the graph-runner integration suites need before
 * calling runFlow: project → platform runner → [flow revision] → flow → task
 * → run → [run_session] → [workspace]. Defaults mirror the historical
 * per-file seed blocks; options carry the per-test deltas.
 */
export async function seedGraphRun(
  db: NodePgDatabase,
  manifest: unknown,
  options: SeedGraphRunOptions = {},
): Promise<SeededGraphRun> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const agent = options.agent ?? "claude";
  const flowRefId = options.flowRefId ?? "g";
  const installedPath = options.installedPath ?? `/tmp/flows/${flowRefId}`;
  const repoPath = options.repoPath ?? `/tmp/${slug}`;
  const workspace = options.workspace ?? {};
  const worktreePath =
    (workspace === false ? undefined : workspace.worktreePath) ??
    (await mkdtemp(join(tmpdir(), "wt-")));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));
  const flowRevision =
    options.flowRevision === true ? {} : options.flowRevision || undefined;
  const flowRevisionId = flowRevision === undefined ? undefined : randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, agent));

  // flows.enabled_revision_id references flow_revisions, so the revision row
  // goes first whenever it is seeded.
  if (flowRevision !== undefined) {
    await db.insert(schema.flowRevisions).values({
      id: flowRevisionId,
      flowRefId,
      source: "github.com/x/y",
      versionLabel: "v1.0.0",
      resolvedRevision:
        flowRevision.resolvedRevision ?? randomUUID().replace(/-/g, ""),
      manifestDigest: "test-digest",
      manifest,
      schemaVersion: 1,
      installedPath,
      setupStatus: "not_required",
      packageStatus: "Installed",
      execTrust: flowRevision.execTrust ?? "trusted",
    });
  }
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath,
    manifest,
    schemaVersion: 1,
    ...(flowRevision?.enabledOnFlow
      ? { enabledRevisionId: flowRevisionId }
      : {}),
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
    ...options.task,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    ...(flowRevisionId === undefined ? {} : { flowRevisionId }),
    flowVersion: "v1.0.0",
    status: "Running",
    ...(options.runnerOnRun
      ? {
          runnerId: executorId,
          capabilityAgent: agent,
          runnerSnapshot: testRunnerSnapshot(executorId, agent),
        }
      : {}),
    ...options.run,
  });
  if (!options.runnerOnRun) {
    await db.insert(schema.runSessions).values({
      id: randomUUID(),
      runId,
      sessionName: "default",
      runnerId: executorId,
      capabilityAgent: agent,
      runnerSnapshot: testRunnerSnapshot(executorId, agent),
    });
  }
  if (workspace !== false) {
    await db.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId,
      branch: "feature/test",
      worktreePath,
      parentRepoPath: repoPath,
      ...workspace,
    });
  }

  return {
    projectId,
    slug,
    executorId,
    flowId,
    flowRevisionId,
    taskId,
    runId,
    worktreePath,
    runtimeRoot,
    repoPath,
  };
}

// ADR-165: register a local execution host row (idempotent on `hostKey`) and
// mint the run's `launch` assignment on it — what `launchRun` does inside its
// run-insert transaction, for suites that seed runs directly.
export async function seedExecutionAssignment(
  db: NodePgDatabase,
  input: { runId: string; hostKey?: string; bootId?: string },
): Promise<{ hostId: string; assignmentId: string; epoch: number }> {
  const hostKey = input.hostKey ?? `eh_${randomUUID().replace(/-/g, "")}`;
  const existing = (await db
    .select({ id: schema.executionHosts.id })
    .from(schema.executionHosts)
    .where(eq(schema.executionHosts.hostKey, hostKey))) as Array<{
    id: string;
  }>;
  let hostId = existing[0]?.id;

  if (!hostId) {
    hostId = randomUUID();
    await db.insert(schema.executionHosts).values({
      id: hostId,
      hostKey,
      kind: "local_direct",
      displayName: "seeded local host",
      transport: { kind: "local_direct" },
      capabilities: {
        protocolVersion: 1,
        supervisorVersion: "test",
        adapters: [],
      },
      readiness: "ready",
      lastBootId: input.bootId ?? randomUUID(),
      lastSeenAt: new Date(),
    });
  }

  const assignmentId = randomUUID();

  await db.insert(schema.executionAssignments).values({
    id: assignmentId,
    runId: input.runId,
    executionHostId: hostId,
    epoch: 1,
    state: "active",
    placementReason: "launch",
  });
  await db
    .update(schema.runs)
    .set({ executionAssignmentId: assignmentId })
    .where(eq(schema.runs.id, input.runId));

  return { hostId, assignmentId, epoch: 1 };
}
