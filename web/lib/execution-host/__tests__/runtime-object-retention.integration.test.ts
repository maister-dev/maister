import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { publishRuntimeObject } from "@/lib/execution-host/runtime-objects";
import { MaisterError } from "@/lib/errors";
import { sweepExpiredRuntimeObjects } from "@/lib/execution-host/runtime-object-retention";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: Db;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "runtime_object_retention_test",
  });
  db = testDatabase.db as unknown as Db;
}, 120_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("runtime object retention", () => {
  it("keeps a durable delete intent unavailable after a terminal host refusal", async () => {
    const project = await seedProjectRow(testDatabase.db);
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      status: "Review",
    });
    const { hosts, fake } = await fakeExecutionHosts(db, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const objectId = randomUUID();

    await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: "refused.txt",
      mimeType: "text/plain",
      retentionClass: "ephemeral",
      expiresAt: "2026-09-04T11:59:00.000Z",
      bytes: new TextEncoder().encode("retained fixture"),
    });
    fake.transport.deleteRuntimeObject = async () => {
      throw new MaisterError("PRECONDITION", "fixture delete refusal");
    };
    const summary = await sweepExpiredRuntimeObjects({
      db,
      hosts,
      now: new Date("2026-09-04T12:00:00.000Z"),
    });
    const result = await testDatabase.pool.query<{ state: string }>(
      "select state from execution_runtime_objects where id = $1",
      [objectId],
    );

    expect(summary.failed).toBe(1);
    expect(result.rows).toEqual([{ state: "deleting" }]);
  });

  it("deletes only expired, unreferenced ephemeral objects through their original assignment", async () => {
    const project = await seedProjectRow(testDatabase.db);
    const runId = await seedRun(testDatabase.db, {
      projectId: project.id,
      status: "Review",
    });
    const { hosts, fake } = await fakeExecutionHosts(db, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });
    const now = new Date("2026-09-04T12:00:00.000Z");

    const publish = async (name: string, expiresAt: Date) => {
      const objectId = randomUUID();

      await publishRuntimeObject({
        client,
        objectId,
        kind: "generated_artifact",
        logicalName: name,
        mimeType: "text/plain",
        retentionClass: "ephemeral",
        expiresAt: expiresAt.toISOString(),
        bytes: new TextEncoder().encode(name),
      });

      return objectId;
    };
    const expired = await publish(
      "expired.txt",
      new Date("2026-09-04T11:59:00.000Z"),
    );
    const referenced = await publish(
      "referenced.txt",
      new Date("2026-09-04T11:59:00.000Z"),
    );
    const future = await publish(
      "future.txt",
      new Date("2026-09-04T12:01:00.000Z"),
    );

    await db.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      kind: "generic_file",
      producer: "runner",
      locator: { kind: "execution-object", objectId: referenced },
      retention: "ephemeral",
    });

    const summary = await sweepExpiredRuntimeObjects({ db, hosts, now });
    const rows = await testDatabase.pool.query(
      `select id, state from execution_runtime_objects
       where id = any($1::text[]) order by id`,
      [[expired, referenced, future]],
    );

    expect(summary).toMatchObject({
      scanned: 2,
      deleted: 1,
      referenced: 1,
      failed: 0,
    });
    expect(rows.rows).toEqual(
      [
        { id: expired, state: "deleted" },
        { id: referenced, state: "available" },
        { id: future, state: "available" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      fake.callsOf("deleteRuntimeObject").map((call) => call.args[0]),
    ).toEqual([expired]);
  }, 120_000);
});
