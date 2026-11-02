import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";
import path from "node:path";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  flows,
  flowRevisions,
  platformAcpRunners,
  platformRuntimeSettings,
} from "@/lib/db/schema";
import { initRepo } from "@/test-support/git-fixture";

export type TaskLaunchFixture = Readonly<{
  userId: string;
  projectId: string;
  flowId: string;
  runnerId: string;
  repo: string;
}>;

export async function seedTaskLaunchFixture(
  database: StartedPostgresTestDb,
  root: string,
): Promise<TaskLaunchFixture> {
  const repo = await initRepo(path.join(root, "repo"));

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
    installedPath: root,
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
    installedPath: root,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });

  return { userId, projectId, flowId, runnerId, repo };
}
