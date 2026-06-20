import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emitDomainEvent } from "@/lib/domain-events/outbox";
// FIXME(any): drizzle-orm dual peer-dep variants — runtime works, cast silences
// the type-only clash (matches emit-run-status.integration.test.ts).
import * as fullSchema from "@/lib/db/schema";

// =============================================================================
// T4 — emitDomainEvent transactional coupling (AC1, ADR-086).
//
//   T-E1: an INSERT riding a COMMITTED caller transaction produces exactly one
//         domain_events row with kind/ids/actor/payload mapped and tx_id
//         populated by pg_current_xact_id().
//   T-E2: the same INSERT inside a ROLLED-BACK transaction leaves zero rows —
//         the event exists iff the domain write committed.
// =============================================================================

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.domainEvents);
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  return projectId;
}

describe("emitDomainEvent — same-transaction capture (AC1)", () => {
  it("T-E1: a committed caller tx yields exactly one mapped row with tx_id set", async () => {
    const projectId = await seedProject();
    const occurredAt = new Date("2026-06-11T12:00:00.000Z");

    await (db as any).transaction(async (tx: any) => {
      await emitDomainEvent({
        db: tx,
        kind: "task.created",
        projectId,
        actor: { type: "user", id: "user-1" },
        payload: { taskKey: "T1-1", title: "hello" },
        occurredAt,
      });
    });

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    expect(row.kind).toBe("task.created");
    expect(row.projectId).toBe(projectId);
    expect(row.taskId).toBeNull();
    expect(row.runId).toBeNull();
    expect(row.actorType).toBe("user");
    expect(row.actorId).toBe("user-1");
    expect(row.payload).toEqual({ taskKey: "T1-1", title: "hello" });
    expect((row.occurredAt as Date).toISOString()).toBe(
      occurredAt.toISOString(),
    );
    expect(typeof row.id).toBe("number");
    expect(row.id as number).toBeGreaterThan(0);
    // xid8 horizon column populated by the DB default.
    expect(row.txId).toBeTruthy();
  });

  it("T-E1b: system actor and nullable refs map to NULL columns", async () => {
    const projectId = await seedProject();

    await (db as any).transaction(async (tx: any) => {
      await emitDomainEvent({
        db: tx,
        kind: "run.failed",
        projectId,
        actor: { type: "system", id: null },
        parentRunId: null,
        payload: { runId: "r-1", runKind: "flow" },
      });
    });

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;

    expect(row.actorType).toBe("system");
    expect(row.actorId).toBeNull();
    // M37 (ADR-098): run-terminal kinds fold parent_run_id into the payload;
    // a top-level run serializes parentRunId: null.
    expect(row.payload).toEqual({
      runId: "r-1",
      runKind: "flow",
      parentRunId: null,
    });
  });

  it("T-E2: a rolled-back caller tx leaves zero rows", async () => {
    const projectId = await seedProject();

    await expect(
      (db as any).transaction(async (tx: any) => {
        await emitDomainEvent({
          db: tx,
          kind: "task.created",
          projectId,
          payload: { taskKey: "T1-2", title: "doomed" },
        });
        throw new Error("simulated domain-write failure after emit");
      }),
    ).rejects.toThrow("simulated domain-write failure after emit");

    const rows = await db.select().from(schema.domainEvents);

    expect(rows).toHaveLength(0);
  });
});
