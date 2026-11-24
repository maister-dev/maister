import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { redactPayload } from "../redact";

import {
  seedLocalHost,
  seedProjectRow,
  seedRun,
} from "@/test-support/execution-host-seed";
import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "object_declaration_upgrade" },
    "0159_mandatory_prompt_owner",
  );
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

it("backfills only the original provable declaration without inventing one from a seal or a later request", async () => {
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, { projectId: project.id });
  const host = await seedLocalHost(database.db);
  const assignment = { id: randomUUID(), epoch: 1 };

  // Write records in their 0159 shape. Current ledger writers require columns
  // introduced by later migrations.
  await database.pool.query(
    `INSERT INTO execution_assignments
      (id, run_id, execution_host_id, epoch, state, placement_reason)
      VALUES ($1, $2, $3, $4, 'active', 'launch')`,
    [assignment.id, runId, host.id, assignment.epoch],
  );
  await database.pool.query(
    "UPDATE runs SET execution_assignment_id = $1 WHERE id = $2",
    [assignment.id, runId],
  );
  // Exact, compacted, producer-only, changed expiry, ambiguous first timestamp,
  // and an exact ephemeral declaration exercise independent proof boundaries.
  const objectIds = Array.from({ length: 6 }, () => randomUUID());
  const reserveCommand = async (
    objectId: string,
    payload: Record<string, unknown>,
    at: Date,
  ): Promise<string> => {
    const id = randomUUID();

    await database.pool.query(
      `INSERT INTO execution_commands
      (id, run_id, execution_assignment_id, execution_host_id, assignment_epoch,
       kind, target_session_id, payload, state, attempts, max_attempts,
       driverless, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 'runtime_object.reserve', $6, $7, 'queued',
        0, 1, false, $8, $8)`,
      [
        id,
        runId,
        assignment.id,
        host.id,
        assignment.epoch,
        objectId,
        JSON.stringify(redactPayload("runtime_object.reserve", payload)),
        at,
      ],
    );

    return id;
  };

  for (const [index, objectId] of objectIds.entries()) {
    await database.pool.query(
      `INSERT INTO execution_runtime_objects
      (id, run_id, execution_host_id, execution_assignment_id, assignment_epoch,
       kind, logical_name, mime_type, generation, retention_class, state, size_bytes, sha256, sealed_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'generated_artifact', 'fixture.txt', 'text/plain', 1, $10,
        $6, $7, $8, $9, $11)`,
      [
        objectId,
        runId,
        host.id,
        assignment.id,
        assignment.epoch,
        index === 2 ? "available" : "pending",
        index === 2 ? 42 : null,
        index === 2 ? "c".repeat(64) : null,
        index === 2 ? new Date("2026-09-08T12:00:00Z") : null,
        index === 3 || index === 5 ? "ephemeral" : "run",
        index === 3 || index === 5 ? new Date("2026-09-09T12:00:00Z") : null,
      ],
    );
    if (index === 2) continue;
    const payload = {
      objectId,
      kind: "generated_artifact",
      logicalName: "fixture.txt",
      mimeType: "text/plain",
      generation: 1,
      retentionClass: index === 3 || index === 5 ? "ephemeral" : "run",
      ...(index === 3 || index === 5
        ? {
            expiresAt:
              index === 3 ? "2026-09-10T12:00:00Z" : "2026-09-09T12:00:00Z",
          }
        : {}),
      sizeBytes: 42,
      sha256: "a".repeat(64),
    };
    const originalId = await reserveCommand(
      objectId,
      payload,
      new Date("2026-09-08T12:00:00Z"),
    );

    await reserveCommand(
      objectId,
      { ...payload, sizeBytes: 43, sha256: "b".repeat(64) },
      new Date(index === 4 ? "2026-09-08T12:00:00Z" : "2026-09-08T12:00:01Z"),
    );
    if (index === 1)
      await database.pool.query(
        "UPDATE execution_commands SET payload = '{}'::jsonb WHERE id = $1",
        [originalId],
      );
  }
  const before = await database.pool.query(
    "SELECT id, state, size_bytes, sha256, sealed_at FROM execution_runtime_objects ORDER BY id",
  );

  await applyMainMigration(database.db, "0160_runtime_object_declarations");
  const after = await database.pool.query(
    "SELECT id, state, size_bytes, sha256, sealed_at FROM execution_runtime_objects ORDER BY id",
  );

  expect(after.rows).toEqual(before.rows);
  for (const [index, objectId] of objectIds.entries()) {
    const declaration = await database.pool.query(
      "SELECT declared_size_bytes, declared_sha256 FROM execution_runtime_objects WHERE id = $1",
      [objectId],
    );

    expect.soft(declaration.rows).toEqual([
      {
        declared_size_bytes: index === 0 || index === 5 ? "42" : null,
        declared_sha256: index === 0 || index === 5 ? "a".repeat(64) : null,
      },
    ]);
  }
});
