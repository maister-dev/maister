// ADR-121 §4.6: cycle-safe gating relations against real Postgres. Direct +
// transitive cycle refusal (CONFLICT), non-gating kinds never checked, valid
// edges succeed, and the two-racer in-tx guarantee (at most one commits).

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { addTaskRelation, type TaskRelationKind } from "@/lib/social/relations";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

const ACTOR = { type: "user" as const, id: "tester" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_relations_cycle_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let seq = 0;

async function seedProjectWithTasks(
  count: number,
): Promise<{ projectId: string; taskIds: string[] }> {
  const projectId = randomUUID();
  const slug = `cyc-${projectId.slice(0, 8)}`;

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: `Cycle ${slug}`,
    repoPath: `/tmp/${slug}`,
    taskKey: `C${projectId.slice(0, 8)}`.toUpperCase(),
  });

  const taskIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = randomUUID();

    seq += 1;
    await db.insert(schema.tasks).values({
      id,
      projectId,
      number: seq,
      title: `t${i}`,
      prompt: "p",
    });
    taskIds.push(id);
  }

  return { projectId, taskIds };
}

function add(
  projectId: string,
  fromTaskId: string,
  kind: TaskRelationKind,
  toTaskId: string,
  handle: NodePgDatabase = db,
) {
  return addTaskRelation(
    { projectId, fromTaskId, kind, toTaskId, actor: ACTOR },
    handle,
  );
}

async function expectConflict(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error("expected CONFLICT, but the relation was accepted");
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CONFLICT");
  }
}

describe("gating-relation cycle safety (ADR-121 §4.6)", () => {
  it("AC-G1a: refuses a direct cycle A blocks B, B blocks A → CONFLICT", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(2);
    const [a, b] = taskIds;

    await expect(add(projectId, a, "blocks", b)).resolves.toEqual({
      created: true,
    });
    await expectConflict(add(projectId, b, "blocks", a));
  });

  it("AC-G1b: refuses a transitive cycle A→B→C→A → CONFLICT", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(3);
    const [a, b, c] = taskIds;

    await add(projectId, a, "blocks", b);
    await add(projectId, b, "blocks", c);
    await expectConflict(add(projectId, c, "blocks", a));
  });

  it("AC-G1b': detects cycles across normalized blocks/depends_on edges", async () => {
    // A blocks B  ⇒ A precedes B. B depends_on A is the SAME precedence edge, so
    // a depends_on the other way closes the loop: B blocks A expressed as
    // A depends_on B would mean B precedes A → cycle with A precedes B.
    const { projectId, taskIds } = await seedProjectWithTasks(2);
    const [a, b] = taskIds;

    await add(projectId, a, "blocks", b); // A precedes B
    await expectConflict(add(projectId, a, "depends_on", b)); // B precedes A → cycle
  });

  it("AC-G1b'': requires participates in cycle detection (success-gated DAG)", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(2);
    const [a, b] = taskIds;

    await add(projectId, a, "requires", b); // B precedes A
    await expectConflict(add(projectId, b, "requires", a)); // A precedes B → cycle
  });

  it("AC-G1d: parent_of / duplicate_of are NEVER cycle-checked", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(2);
    const [a, b] = taskIds;

    await add(projectId, a, "parent_of", b);
    await expect(add(projectId, b, "parent_of", a)).resolves.toEqual({
      created: true,
    });
    await add(projectId, a, "duplicate_of", b);
    await expect(add(projectId, b, "duplicate_of", a)).resolves.toEqual({
      created: true,
    });
  });

  it("AC-G1f: a valid non-closing gating edge succeeds", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(3);
    const [a, b, c] = taskIds;

    await add(projectId, a, "blocks", b);
    await expect(add(projectId, b, "blocks", c)).resolves.toEqual({
      created: true,
    });
    // A diamond (A→B, A→C, B→D, C→D) has no cycle.
    await expect(add(projectId, a, "blocks", c)).resolves.toEqual({
      created: true,
    });
  });

  it("AC-G1e: two transactions racing to close a cycle → at most one commits", async () => {
    const { projectId, taskIds } = await seedProjectWithTasks(2);
    const [a, b] = taskIds;

    // Both directions race from an empty graph; the per-project advisory lock
    // serializes them so the second sees the first's committed edge and rejects.
    const results = await Promise.allSettled([
      add(projectId, a, "blocks", b),
      add(projectId, b, "blocks", a),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isMaisterError((rejected[0] as PromiseRejectedResult).reason)).toBe(
      true,
    );
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as { code: string }).code,
    ).toBe("CONFLICT");

    // Exactly one edge persisted.
    const count = await pool.query(
      "select count(*)::int as n from task_relations where project_id = $1",
      [projectId],
    );

    expect(count.rows[0].n).toBe(1);
  });
});
