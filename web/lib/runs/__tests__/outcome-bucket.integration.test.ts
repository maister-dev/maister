// ADR-178 D3: the outcome-bucket matrix on real Postgres.
//
// The CASE fragment is generated from `BUCKET_BY_RUN_STATUS`, so the unit test
// can only prove it is WELL-FORMED. What it classifies a real row as — and in
// particular which `workspaces` row it reads when a run has several — is a
// database fact, and this is the suite that pins it.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { RUN_STATUS_VALUES } from "@/lib/runs/run-status-values";
import {
  latestWorkspaceLateralSql,
  runOutcomeBucketSql,
  type RunOutcomeBucket,
} from "@/lib/runs/outcome-bucket";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let projectId: string;

const NOW = new Date("2026-06-05T12:00:00.000Z");

/**
 * The workspace shapes a run can present to the classifier.
 *
 * `noWorkspace` is not a hypothetical: an ADR-165 result-only flow and a
 * `workspace: none` agent run both reach `Done` without ever creating a row.
 */
const WORKSPACE_VARIANTS = {
  noWorkspace: null,
  promotionNone: { promotionState: "none" },
  localMergeDone: { promotionState: "done", promotionMode: "local_merge" },
  prStateNull: { promotionState: "done", promotionMode: "pull_request" },
  prOpen: {
    promotionState: "done",
    promotionMode: "pull_request",
    prState: "open" as const,
  },
  prMerged: {
    promotionState: "done",
    promotionMode: "pull_request",
    prState: "merged" as const,
  },
  prClosed: {
    promotionState: "done",
    promotionMode: "pull_request",
    prState: "closed" as const,
  },
  removedUnpromoted: { promotionState: "none", removed: true },
  removedAfterMerge: {
    promotionState: "done",
    promotionMode: "local_merge",
    removed: true,
  },
  // The three promotion states ADR-178 argues cannot sit beside a `Done` run
  // (a claim in flight and a finalize failure both leave the run in `Review`;
  // ADR-141 `reopen` flips it back to `Review` as it writes `reopened`).
  // Seeded anyway: "unreachable" was previously asserted by a test that
  // compared a local constant with itself and never touched the classifier, so
  // the fallthrough it relies on was undefined behaviour in practice. These
  // rows PIN what the CASE actually returns, and a reordering that changes it
  // fails here.
  promotionClaiming: {
    promotionState: "claiming",
    promotionMode: "local_merge",
  },
  promotionFailed: { promotionState: "failed", promotionMode: "local_merge" },
  promotionReopened: {
    promotionState: "reopened",
    promotionMode: "local_merge",
  },
} satisfies Record<string, WorkspaceSpec | null>;

type VariantName = keyof typeof WORKSPACE_VARIANTS;

interface WorkspaceSpec {
  promotionState: string;
  promotionMode?: string;
  prState?: "open" | "merged" | "closed";
  removed?: boolean;
}

/**
 * The D3 table restated as a lookup, independently of the generated SQL.
 *
 * Writing it as data rather than by calling the generator is the point: the two
 * can then disagree, and a rule that quietly changes shape fails here.
 */
const EXPECTED: Record<
  string,
  Partial<Record<VariantName, RunOutcomeBucket>>
> = {
  Pending: all("Queued"),
  Running: all("Executing"),
  WaitingOnChildren: all("Executing"),
  NeedsInput: all("WaitingOnHuman"),
  NeedsInputIdle: all("WaitingOnHuman"),
  HumanWorking: all("WaitingOnHuman"),
  // Beside `Review` / `Crashed` the three in-flight promotion states classify
  // by status alone — which is the reachable half of the pair, and the half
  // the ADR's own argument depends on.
  Review: {
    ...all("Review"),
    removedUnpromoted: "Abandoned",
    removedAfterMerge: "Abandoned",
  },
  Crashed: {
    ...all("Crashed"),
    removedUnpromoted: "Abandoned",
    removedAfterMerge: "Abandoned",
  },
  Failed: all("Failed"),
  Abandoned: all("Abandoned"),
  Done: {
    noWorkspace: "ResultOnly",
    promotionNone: "ResultOnly",
    localMergeDone: "Delivered",
    prStateNull: "PrOpen",
    prOpen: "PrOpen",
    prMerged: "Delivered",
    prClosed: "Abandoned",
    removedUnpromoted: "ResultOnly",
    // GC of a merged worktree does not undo the delivery it already made.
    removedAfterMerge: "Delivered",
    // Not `ResultOnly` (promotion_state is neither NULL nor 'none') and not a
    // PR arm, so all three fall through the refinements to the status map:
    // `Done -> Delivered`. Documented, not endorsed — see UNREACHABLE.
    promotionClaiming: "Delivered",
    promotionFailed: "Delivered",
    promotionReopened: "Delivered",
  },
};

/**
 * `Done` beside an in-flight promotion state: why ADR-178 D3's `Delivered` rule
 * reads `promotion_state = 'done'` while the SQL lets these fall through.
 *
 * `promotion_state` carries five values; only `none` and `done` are expected
 * beside a `Done` run. A finalize failure leaves the run in `Review` with
 * `failed`, a claim in progress leaves it `Review` with `claiming`, and ADR-141
 * `reopen` flips a `Done` run back to `Review` as it writes `reopened`.
 *
 * Nothing ENFORCES that — `workspaces.promotion_state` is a plain
 * `text NOT NULL DEFAULT 'none'` with no CHECK, and no FK or trigger couples it
 * to `runs.status`. So the three combinations are seeded above and their actual
 * classification asserted, rather than asserted to be impossible: an
 * unreachable-by-argument row that DOES appear must land somewhere explicit,
 * and `Delivered` (the run is `Done`) is the answer this matrix pins.
 */
const UNREACHABLE_BY_ARGUMENT = [
  {
    variant: "promotionClaiming",
    reason: "promotion claim in flight keeps the run in Review",
  },
  {
    variant: "promotionFailed",
    reason: "finalize failure leaves the run in Review",
  },
  {
    variant: "promotionReopened",
    reason: "ADR-141 reopen flips the run back to Review",
  },
] as const satisfies readonly { variant: VariantName; reason: string }[];

function all(bucket: RunOutcomeBucket): Record<VariantName, RunOutcomeBucket> {
  return Object.fromEntries(
    (Object.keys(WORKSPACE_VARIANTS) as VariantName[]).map((variant) => [
      variant,
      bucket,
    ]),
  ) as Record<VariantName, RunOutcomeBucket>;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("outcome_bucket")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await db.delete(schema.workspaces);
  await db.delete(schema.runs);
  await db.delete(schema.projects);

  projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId,
    taskKey: `K${randomUUID().slice(0, 8)}`.toUpperCase(),
    slug: `bucket-${projectId.slice(0, 8)}`,
    name: "Outcome bucket",
    repoPath: `/repos/${projectId}`,
    maisterYamlPath: `/repos/${projectId}/maister.yaml`,
  });
});

describe("runOutcomeBucketSql over real rows (ADR-178 D3)", () => {
  it("classifies every reachable run status x workspace shape per the D3 table", async () => {
    const expected = new Map<string, RunOutcomeBucket>();

    for (const status of RUN_STATUS_VALUES) {
      for (const variant of Object.keys(WORKSPACE_VARIANTS) as VariantName[]) {
        const runId = await seedRun(status, variant);
        const bucket = EXPECTED[status]?.[variant];

        expect(
          bucket,
          `no D3 expectation for ${status} x ${variant}`,
        ).toBeDefined();
        expected.set(runId, bucket as RunOutcomeBucket);
      }
    }

    const actual = await readBuckets();

    expect(actual.size).toBe(
      RUN_STATUS_VALUES.length * Object.keys(WORKSPACE_VARIANTS).length,
    );
    for (const [runId, bucket] of expected) {
      expect(actual.get(runId), `run ${runId}`).toBe(bucket);
    }
  });

  it("classifies a run with several workspaces rows by its NEWEST row", async () => {
    // Promoted first, then the worktree was removed: the run is abandoned work.
    const newerRemoved = await seedRun("Review", "localMergeDone");

    await insertWorkspace(newerRemoved, WORKSPACE_VARIANTS.removedUnpromoted, {
      createdAt: new Date(NOW.getTime() + 60_000),
    });

    // The reverse order: the removal is history and the run is back in Review.
    const newerActive = await seedRun("Review", "removedUnpromoted");

    await insertWorkspace(newerActive, WORKSPACE_VARIANTS.localMergeDone, {
      createdAt: new Date(NOW.getTime() + 60_000),
    });

    const actual = await readBuckets();

    expect(actual.get(newerRemoved)).toBe("Abandoned");
    expect(actual.get(newerActive)).toBe("Review");
  });

  it("breaks a same-timestamp tie by id ASC, exactly as the ledger lateral does", async () => {
    const runId = await seedRun("Review", "noWorkspace");

    await insertWorkspace(runId, WORKSPACE_VARIANTS.removedUnpromoted, {
      id: "aaaa-tie",
      createdAt: NOW,
    });
    await insertWorkspace(runId, WORKSPACE_VARIANTS.localMergeDone, {
      id: "bbbb-tie",
      createdAt: NOW,
    });

    const actual = await readBuckets();

    // `ORDER BY created_at DESC, id ASC` picks the LOWEST id among equals.
    expect(actual.get(runId)).toBe("Abandoned");
  });

  it("lands a Done run on Delivered for every promotion state it should never carry", async () => {
    const seeded = new Map<string, VariantName>();

    for (const { variant } of UNREACHABLE_BY_ARGUMENT) {
      seeded.set(await seedRun("Done", variant), variant);
    }

    const actual = await readBuckets();

    for (const [runId, variant] of seeded) {
      // The point is that the CASE has an answer at all, and that it is the
      // one the D3 table would give for a Done run. A row nobody expects must
      // not vanish from a total or land in a column it contradicts.
      expect(actual.get(runId), variant).toBe("Delivered");
    }
    expect(seeded.size).toBe(3);
  });
});

async function readBuckets(): Promise<Map<string, RunOutcomeBucket>> {
  const result = await db.execute(sql`
    SELECT r.id AS run_id,
           ${runOutcomeBucketSql({
             status: sql`r.status`,
             promotionState: sql`w.promotion_state`,
             promotionMode: sql`w.promotion_mode`,
             prState: sql`w.pr_state`,
             removedAt: sql`w.removed_at`,
           })} AS bucket
    FROM runs r
    ${latestWorkspaceLateralSql("r")}
  `);

  return new Map(
    (result.rows as Array<{ run_id: string; bucket: RunOutcomeBucket }>).map(
      (row) => [row.run_id, row.bucket],
    ),
  );
}

async function seedRun(
  status: schema.RunStatus,
  variant: VariantName,
): Promise<string> {
  const runId = randomUUID();

  await db.insert(schema.runs).values({
    id: runId,
    projectId,
    runKind: "flow",
    status,
    flowVersion: "v1.0.0",
    startedAt: NOW,
    endedAt: status === "Pending" || status === "Running" ? null : NOW,
  });

  const spec = WORKSPACE_VARIANTS[variant];

  if (spec) await insertWorkspace(runId, spec, { createdAt: NOW });

  return runId;
}

async function insertWorkspace(
  runId: string,
  spec: WorkspaceSpec,
  options: { createdAt: Date; id?: string },
): Promise<void> {
  const id = options.id ?? randomUUID();

  await db.insert(schema.workspaces).values({
    id,
    runId,
    projectId,
    branch: `maister/${id.slice(0, 8)}`,
    worktreePath: `/worktrees/${id}`,
    parentRepoPath: `/repos/${projectId}`,
    createdAt: options.createdAt,
    promotionState: spec.promotionState,
    promotionMode: spec.promotionMode ?? null,
    prState: spec.prState ?? null,
    removedAt: spec.removed ? NOW : null,
    // The `workspaces_removed_result_check` constraint requires a kind
    // whenever `removed_at` is set.
    removalKind: spec.removed ? "drop" : null,
  });
}
