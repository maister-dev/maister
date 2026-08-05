// ADR-121 §4.6: cycle-safe gating relations against real Postgres. Direct +
// transitive cycle refusal (CONFLICT), non-gating kinds never checked, valid
// edges succeed, and the two-racer in-tx guarantee (at most one commits).

import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { addTaskRelation, type TaskRelationKind } from "@/lib/social/relations";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

const ACTOR = { type: "user" as const, id: "tester" };

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_relations_cycle_test",
  });
  container = testDatabase.container;

  // relations.ts gates its pg_advisory_xact_lock on DB_URL looking like
  // Postgres; vitest workers don't inherit .env.local, so without this the
  // lock is silently skipped and AC-G1e rests on connection-timing luck.
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  pool = testDatabase.pool;
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;

  await testDatabase?.stop();
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

    // Warm every pool slot first: a cold second connection (~5ms setup) would
    // serialize the racers by accident and let a skipped lock pass undetected.
    await Promise.all(Array.from({ length: 4 }, () => pool.query("select 1")));

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

describe("cross-project gating relations (ADR-155)", () => {
  it("AC-X1: refuses a 2-cycle whose legs live in different projects", async () => {
    const pa = await seedProjectWithTasks(1);
    const pb = await seedProjectWithTasks(1);
    const [a] = pa.taskIds;
    const [b] = pb.taskIds;

    await expect(add(pa.projectId, a, "blocks", b)).resolves.toEqual({
      created: true,
    });
    await expectConflict(add(pb.projectId, b, "blocks", a));
  });

  it("AC-X2: refuses a 4-project cycle under concurrent inserts (D1)", async () => {
    // The regression that proves the lock is platform-wide, not per-project.
    // Committed: A→B (locks project A) and C→D (locks project C). The racing
    // pair B→C and D→A take DISJOINT per-project locks ({B} and {D}), so under
    // per-project locking they run concurrently, each BFS misses the other's
    // uncommitted leg, both commit, and A→B→C→D→A deadlocks every gated task
    // in it forever. One platform-wide lock serializes them.
    const [pa, pb, pc, pd] = await Promise.all([
      seedProjectWithTasks(1),
      seedProjectWithTasks(1),
      seedProjectWithTasks(1),
      seedProjectWithTasks(1),
    ]);
    const [a] = pa.taskIds;
    const [b] = pb.taskIds;
    const [c] = pc.taskIds;
    const [d] = pd.taskIds;

    await add(pa.projectId, a, "blocks", b);
    await add(pc.projectId, c, "blocks", d);

    // Warm every pool slot: a cold connection would serialize the racers by
    // accident and let a per-project lock pass undetected.
    await Promise.all(Array.from({ length: 4 }, () => pool.query("select 1")));

    const results = await Promise.allSettled([
      add(pb.projectId, b, "blocks", c),
      add(pd.projectId, d, "blocks", a),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as { code: string }).code,
    ).toBe("CONFLICT");

    const closed = await pool.query(
      "select count(*)::int as n from task_relations where from_task_id = any($1::text[])",
      [[b, d]],
    );

    expect(closed.rows[0].n).toBe(1);
  });

  it("AC-X3: refuses when the traversal exceeds GATING_BFS_MAX_NODES", async () => {
    // A chain longer than the cap that closes NO cycle: without the bound the
    // BFS walks it and accepts. Refusing is the safe direction — a false
    // refusal is visible and recoverable, a missed cycle is a deadlock.
    const CHAIN = 5100;
    const projectId = randomUUID();
    const slug = `cap-${projectId.slice(0, 8)}`;

    await db.insert(schema.projects).values({
      id: projectId,
      slug,
      name: `Cap ${slug}`,
      repoPath: `/tmp/${slug}`,
      taskKey: `K${projectId.slice(0, 8)}`.toUpperCase(),
    });

    await pool.query(
      `insert into tasks (id, project_id, number, title, prompt)
       select gen_random_uuid()::text, $1, g, 'cap' || g, 'p'
       from generate_series(1, $2) as g`,
      [projectId, CHAIN + 1],
    );

    const ids = (
      await pool.query(
        "select id from tasks where project_id = $1 order by number",
        [projectId],
      )
    ).rows.map((r: { id: string }) => r.id) as string[];

    const froms = ids.slice(1, CHAIN);
    const tos = ids.slice(2, CHAIN + 1);

    await pool.query(
      `insert into task_relations
         (id, project_id, from_task_id, kind, to_task_id, actor_type, actor_id)
       select gen_random_uuid()::text, $1, f, 'blocks', t, 'user', 'tester'
       from unnest($2::text[], $3::text[]) as x(f, t)`,
      [projectId, froms, tos],
    );

    // ids[0] is outside the chain, so the BFS from ids[1] never reaches it.
    try {
      await add(projectId, ids[0], "blocks", ids[1]);
      throw new Error(
        "expected the node-cap refusal, but the edge was accepted",
      );
    } catch (err) {
      expect(isMaisterError(err)).toBe(true);
      expect((err as { code: string }).code).toBe("CONFLICT");
      expect((err as Error).message).toContain("too large");
    }
  });
});
