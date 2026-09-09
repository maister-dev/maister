import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { publishRuntimeObject } from "@/lib/execution-host/runtime-objects";
import { MaisterError } from "@/lib/errors";
import { sweepExpiredRuntimeObjects } from "@/lib/execution-host/runtime-object-retention";
import { recoverExecutionCommands } from "@/lib/execution-host/recovery";
import { UNKNOWN_OUTCOME_DETAIL } from "@/lib/execution-host/contracts";
import { recordCurrentArtifact } from "@/lib/flows/graph/artifact-store";
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

    // The sweep also re-examines the `deleting` queue left by the refusal case
    // above, so only this test's own rows are asserted exactly.
    expect(summary).toMatchObject({ deleted: 1, referenced: 1 });
    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(rows.rows).toEqual(
      [
        { id: expired, state: "deleted" },
        { id: referenced, state: "available" },
        { id: future, state: "available" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(
      fake
        .callsOf("deleteRuntimeObject")
        .map((call) => call.args[0])
        .filter((id) =>
          ([expired, referenced, future] as string[]).includes(String(id)),
        ),
    ).toEqual([expired]);
  }, 120_000);
});

describe("fair runtime object retention (AT-14)", () => {
  const now = new Date("2026-09-04T12:00:00.000Z");
  const expired = "2026-09-04T11:59:00.000Z";
  let fairDatabase: StartedPostgresTestDb;
  let fairDb: Db;

  beforeAll(async () => {
    fairDatabase = await startMainPostgresTestDb({
      databaseName: "runtime_object_fair_retention_test",
    });
    fairDb = fairDatabase.db as unknown as Db;
  }, 120_000);

  afterAll(async () => {
    await fairDatabase?.stop();
  });

  async function runWithHost(status = "Review") {
    const project = await seedProjectRow(fairDatabase.db);
    const runId = await seedRun(fairDatabase.db, {
      projectId: project.id,
      status,
    });
    const { hosts, fake } = await fakeExecutionHosts(fairDb, { runId });
    const client = await hosts.forRun(runId, { reason: "launch" });

    return { project, runId, hosts, fake, client };
  }

  async function publish(
    client: Awaited<ReturnType<typeof runWithHost>>["client"],
    name: string,
    retentionClass: "run" | "delivery" | "ephemeral" = "ephemeral",
  ) {
    const objectId = randomUUID();

    await publishRuntimeObject({
      client,
      objectId,
      kind: "generated_artifact",
      logicalName: name,
      mimeType: "text/plain",
      retentionClass,
      expiresAt: retentionClass === "ephemeral" ? expired : null,
      bytes: new TextEncoder().encode(name),
    });

    return objectId;
  }

  async function reference(
    runId: string,
    objectId: string,
    requiredFor?: ("review" | "merge")[],
  ) {
    await fairDb.insert(schema.artifactInstances).values({
      id: randomUUID(),
      runId,
      kind: "generic_file",
      producer: "runner",
      locator: { kind: "execution-object", objectId },
      retention: "ephemeral",
      ...(requiredFor ? { requiredFor } : {}),
    });
  }

  async function stateOf(objectId: string) {
    const result = await fairDatabase.pool.query<{
      state: string;
      retention_hold: { reason?: string } | null;
    }>(
      "select state, retention_hold from execution_runtime_objects where id = $1",
      [objectId],
    );

    return result.rows[0];
  }

  async function cursor() {
    const result = await fairDatabase.pool.query<{
      cursor_id: string | null;
    }>("select cursor_id from execution_runtime_object_retention_progress");

    return result.rows;
  }

  async function sweepUntilWrapped(
    hosts: Awaited<ReturnType<typeof runWithHost>>["hosts"],
    limit: number,
  ) {
    for (let sweep = 0; sweep < 50; sweep += 1) {
      await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit });
      if ((await cursor())[0]?.cursor_id === null) return sweep + 1;
    }
    throw new Error("retention scan never wrapped");
  }

  it("persists its keyset cursor across sweeps and wraps once the scan is exhausted", async () => {
    const { runId, hosts, client } = await runWithHost();
    const first = await publish(client, "p-0.txt");
    const second = await publish(client, "p-1.txt");

    await reference(runId, first);
    await reference(runId, second);
    const eligible = [
      await publish(client, "e-0.txt"),
      await publish(client, "e-1.txt"),
      await publish(client, "e-2.txt"),
    ];
    const summaries = [];

    for (let sweep = 0; sweep < 3; sweep += 1)
      summaries.push(
        await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit: 2 }),
      );

    expect(summaries.map((summary) => summary.deleted)).toEqual([0, 2, 1]);
    expect(summaries.map((summary) => summary.protected)).toEqual([2, 0, 0]);
    for (const objectId of eligible)
      expect((await stateOf(objectId)).state).toBe("deleted");
    // The third sweep examined fewer rows than its page and wrapped around;
    // the next one starts over and leaves its marker on the last examined row.
    expect(await cursor()).toEqual([{ cursor_id: null }]);
    expect(
      await sweepExpiredRuntimeObjects({ db: fairDb, hosts, now, limit: 2 }),
    ).toMatchObject({ scanned: 2, protected: 2, deleted: 0 });
    expect(await cursor()).toEqual([{ cursor_id: second }]);
  });

  it("reaches an eligible object behind pages of protected ones and records why each was kept", async () => {
    const { runId, hosts, client } = await runWithHost();
    const protectedIds: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const objectId = await publish(client, `protected-${index}.txt`);

      await reference(runId, objectId);
      protectedIds.push(objectId);
    }
    const eligible = await publish(client, "eligible.txt");

    await sweepUntilWrapped(hosts, 2);
    expect((await stateOf(eligible)).state).toBe("deleted");
    for (const objectId of protectedIds)
      expect(await stateOf(objectId)).toMatchObject({
        state: "available",
        retention_hold: { reason: "referenced_artifact" },
      });
  });

  it("cannot delete an object while a reference is being recorded under the object lock", async () => {
    const { runId, hosts, client } = await runWithHost();
    const objectId = await publish(client, "racer.txt");
    const holder = await fairDatabase.pool.connect();

    try {
      await holder.query("BEGIN");
      await holder.query(
        "select id from execution_runtime_objects where id = $1 for update",
        [objectId],
      );
      const sweep = sweepUntilWrapped(hosts, 100);

      await holder.query(
        `insert into artifact_instances (id, run_id, kind, producer, locator, retention)
         values ($1, $2, 'generic_file', 'runner', $3::jsonb, 'ephemeral')`,
        [
          randomUUID(),
          runId,
          JSON.stringify({ kind: "execution-object", objectId }),
        ],
      );
      await holder.query("COMMIT");
      await sweep;
      expect(await stateOf(objectId)).toMatchObject({
        state: "available",
        retention_hold: { reason: "referenced_artifact" },
      });
    } finally {
      holder.release();
    }
  });

  it("refuses a new reference to an object already claimed for deletion", async () => {
    const { runId, hosts, fake, client } = await runWithHost();
    const objectId = await publish(client, "claimed.txt");
    const original = fake.transport.deleteRuntimeObject.bind(fake.transport);

    fake.transport.deleteRuntimeObject = async () => {
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fixture host lost", {
        details: { transport: UNKNOWN_OUTCOME_DETAIL },
      });
    };
    await sweepUntilWrapped(hosts, 100);
    expect((await stateOf(objectId)).state).toBe("deleting");
    await expect(
      recordCurrentArtifact(
        {
          runId,
          kind: "generic_file",
          producer: "runner",
          locator: { kind: "execution-object", objectId },
          retention: "ephemeral",
        },
        fairDb,
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "runtime_object_missing" },
    });
    // The claim completes through its own host once it is reachable again.
    fake.transport.deleteRuntimeObject = original;
    const summary = await recoverExecutionCommands({
      db: fairDb,
      transport: fake.transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect((await stateOf(objectId)).state).toBe("deleted");
  });

  it("holds delivery bytes until delivery is confirmed and required evidence past the run deadline", async () => {
    const { project, runId, hosts, client } = await runWithHost("Done");

    await fairDb.insert(schema.workspaces).values({
      id: randomUUID(),
      runId,
      projectId: project.id,
      branch: "maister/gc",
      worktreePath: `/tmp/maister-gc-${runId}`,
      parentRepoPath: project.repoPath,
      baseBranch: "main",
      prUrl: "https://example.invalid/pr/1",
      prState: "open",
      scheduledRemovalAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    const delivery = await publish(client, "delivery.txt", "delivery");
    const required = await publish(client, "required.txt", "run");
    const plain = await publish(client, "plain.txt", "run");

    await reference(runId, required, ["merge"]);
    await sweepUntilWrapped(hosts, 100);
    expect(await stateOf(delivery)).toMatchObject({
      state: "available",
      retention_hold: { reason: "delivery_unconfirmed" },
    });
    expect(await stateOf(required)).toMatchObject({
      state: "available",
      retention_hold: { reason: "required_evidence" },
    });
    expect((await stateOf(plain)).state).toBe("deleted");

    await fairDb
      .update(schema.workspaces)
      .set({ prState: "merged", prMergedAt: now })
      .where(eq(schema.workspaces.runId, runId));
    await sweepUntilWrapped(hosts, 100);
    expect((await stateOf(delivery)).state).toBe("deleted");
    expect((await stateOf(required)).state).toBe("available");
  });

  it("keeps a lost delete retrying through recovery without a second claim", async () => {
    const { hosts, fake, client } = await runWithHost();
    const objectId = await publish(client, "lost.txt");
    const original = fake.transport.deleteRuntimeObject.bind(fake.transport);
    let attempts = 0;

    fake.transport.deleteRuntimeObject = async () => {
      attempts += 1;
      throw new MaisterError("EXECUTOR_UNAVAILABLE", "fixture host lost", {
        details: { transport: UNKNOWN_OUTCOME_DETAIL },
      });
    };
    await sweepUntilWrapped(hosts, 100);
    await sweepUntilWrapped(hosts, 100);
    expect(await stateOf(objectId)).toMatchObject({
      state: "deleting",
      retention_hold: { reason: "delete_pending" },
    });
    expect(attempts).toBe(1);
    fake.transport.deleteRuntimeObject = original;
    const summary = await recoverExecutionCommands({
      db: fairDb,
      transport: fake.transport,
      graceMs: 0,
    });

    expect(summary.errors).toEqual([]);
    expect((await stateOf(objectId)).state).toBe("deleted");
  });
});
