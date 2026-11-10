import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { captureNativeQualificationDiagnostics } from "../_seed/native-qualification-diagnostics";

import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "maister_e2e" });
}, 180000);

afterAll(async () => {
  await database?.stop();
});

it("retains a bounded sanitized command failure only for the exact synthetic qualification scope", async () => {
  const project = await seedProjectRow(database.db);
  const foreignProject = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, { projectId: project.id });
  const foreignRunId = await seedRun(database.db, {
    projectId: foreignProject.id,
  });
  const host = await seedLocalHost(database.db);
  const assignmentId = randomUUID();
  const commandId = randomUUID();
  const secret = "synthetic-provider-value-never-publish";
  const privatePath = "/private/synthetic-qualification/host";
  const scope = {
    projectId: project.id,
    repoPath: project.repoPath,
    hostPaths: [privatePath],
    secretValues: [secret],
  };

  await database.pool.query(
    "INSERT INTO execution_assignments(id,run_id,execution_host_id,epoch,state,placement_reason) VALUES($1,$2,$3,1,'active','launch')",
    [assignmentId, runId, host.id],
  );
  await database.pool.query(
    "INSERT INTO execution_commands(id,run_id,execution_assignment_id,execution_host_id,assignment_epoch,kind,state,max_attempts,completed_at,last_error) VALUES($1,$2,$3,$4,1,'session.delete','failed',1,now(),$5::jsonb)",
    [
      commandId,
      runId,
      assignmentId,
      host.id,
      JSON.stringify({
        code: "ACP_PROTOCOL",
        message: `${"界".repeat(2000)}\u001b[31m interrupted ${secret} ${privatePath}/session.json provider stream closed`,
      }),
    ],
  );
  const report = await captureNativeQualificationDiagnostics(
    database.pool,
    [runId],
    scope,
  );

  expect(report.commands).toEqual([
    expect.objectContaining({
      id: commandId,
      code: "ACP_PROTOCOL",
      reason: null,
      errorMessage: expect.objectContaining({
        text: expect.stringContaining("provider stream closed"),
        truncated: true,
        controlsRemoved: 5,
        kinds: expect.arrayContaining(["known_secret_value"]),
      }),
    }),
  ]);
  const serialized = JSON.stringify(report);

  expect(report.commands[0]!.errorMessage!.capturedBytes).toBeLessThanOrEqual(
    report.failedOutputMaxBytes,
  );
  expect(report.commands[0]!.errorMessage!.text).not.toContain("\ufffd");
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(privatePath);
  expect(serialized).not.toContain("\u001b");
  await expect(
    captureNativeQualificationDiagnostics(database.pool, [foreignRunId], scope),
  ).rejects.toThrow("cannot read a foreign root");
  await expect(
    captureNativeQualificationDiagnostics(database.pool, [runId], {
      ...scope,
      repoPath: foreignProject.repoPath,
    }),
  ).rejects.toThrow("exact fixture repository");
});
