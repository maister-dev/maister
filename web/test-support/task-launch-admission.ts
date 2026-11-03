import type { StartedPostgresTestDb } from "@/test-support/pg-container";
import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  flows,
  flowRevisions,
  platformAcpRunners,
  platformRuntimeSettings,
  taskLaunchIntents,
  runs,
} from "@/lib/db/schema";
import { initRepo } from "@/test-support/git-fixture";

export type TaskLaunchFixture = Readonly<{
  userId: string;
  projectId: string;
  flowId: string;
  runnerId: string;
  repo: string;
}>;

/** Create the run-bound control state through the real SQL claim/binding guards, without dispatch. */
export async function bindPendingTaskLaunchFixture(
  database: StartedPostgresTestDb,
  intentId: string,
  initialRunContext: Readonly<{
    agentId?: string;
    scheduledRequestSnapshot?: ScheduledAgentRequestSnapshot;
  }> = {},
): Promise<{ runId: string; stateVersion: number }> {
  return database.db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, intentId))
      .for("update");

    if (!intent)
      throw new Error("Pending launch control requires an accepted intent");
    const settings = intent.settingsSnapshot;

    if (
      settings.version !== 2 ||
      settings.kind !== "flow" ||
      (intent.basis.kind !== "manual" && intent.basis.kind !== "automatic")
    )
      throw new Error(
        "Pending launch control requires a current ordinary Flow intent",
      );
    await tx
      .update(taskLaunchIntents)
      .set({
        state: "preparing",
        stateVersion: intent.stateVersion + 1,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(taskLaunchIntents.id, intentId));
    const runId = randomUUID();

    await tx.insert(runs).values({
      id: runId,
      projectId: intent.projectId,
      taskId: intent.taskId,
      runKind: "flow",
      status: "Pending",
      flowId: settings.flowId,
      flowRevisionId: settings.flowRevisionId,
      flowVersion: "v1",
      taskLaunchIntentId: intentId,
      executionPolicy: settings.executionPolicy,
      resolvedCapabilitySet: settings.resolvedCapabilitySet,
      agentId: initialRunContext.agentId,
      scheduledRequestSnapshot: initialRunContext.scheduledRequestSnapshot,
      taskAdmissionSnapshot: {
        version: 2,
        policyVersion: 2,
        mode: intent.basis.kind === "automatic" ? "required" : "manual",
        basis: intent.basis.kind,
        intentId,
        inputRevision: intent.inputRevision,
        qualificationId:
          intent.basis.kind === "automatic"
            ? intent.basis.qualificationId
            : null,
        qualificationRevision:
          intent.basis.kind === "automatic"
            ? intent.basis.qualificationRevision
            : null,
        evidenceTarget: settings.baseBranch,
        evidenceSha: settings.baseCommit,
        parent: null,
      },
    });
    const stateVersion = intent.stateVersion + 2;

    await tx
      .update(taskLaunchIntents)
      .set({
        state: "run_bound",
        stateVersion,
        runId,
        originalRunId: runId,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(taskLaunchIntents.id, intentId));

    return { runId, stateVersion };
  });
}

export async function seedTaskLaunchFixture(
  database: StartedPostgresTestDb,
  root: string,
): Promise<TaskLaunchFixture> {
  const repo = await initRepo(path.join(root, "repo"));
  const flowInstallPath = path.join(root, "flow");

  await mkdir(flowInstallPath, { recursive: true });

  const userId = randomUUID();
  const projectId = randomUUID();
  const flowId = randomUUID();
  const runnerId = randomUUID();
  const revisionId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'admin','active',false)",
    [userId, `${userId}@test.local`],
  );
  await database.pool.query(
    "INSERT INTO projects(id,slug,name,repo_path,task_key,task_qualification_baseline) VALUES($1,$1,'Launch',$2,'LAUNCH','required')",
    [projectId, repo],
  );
  await database.db
    .insert(platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "codex",
      ) as typeof platformAcpRunners.$inferInsert,
    );
  await database.db
    .insert(platformRuntimeSettings)
    .values({ id: "singleton", defaultRunnerId: runnerId })
    .onConflictDoUpdate({
      target: platformRuntimeSettings.id,
      set: { defaultRunnerId: runnerId },
    });
  const manifest = {
    schemaVersion: 1,
    name: "Launch fixture",
    nodes: [
      {
        id: "check",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  };

  await database.db.insert(flowRevisions).values({
    id: revisionId,
    flowRefId: flowId,
    source: "local",
    versionLabel: "v1",
    resolvedRevision: "fixture",
    manifestDigest: "a".repeat(64),
    manifest,
    schemaVersion: 1,
    installedPath: flowInstallPath,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await database.db.insert(flows).values({
    id: flowId,
    projectId,
    flowRefId: flowId,
    source: "local",
    version: "v1",
    installedPath: flowInstallPath,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });

  return { userId, projectId, flowId, runnerId, repo };
}
