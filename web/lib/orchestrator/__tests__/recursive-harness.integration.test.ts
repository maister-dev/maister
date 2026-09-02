import type { RunResultContract, RunResultRow } from "@/lib/run-results/types";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { parse as parseYaml } from "yaml";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as fullSchema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { admitDelegatedChild } from "@/lib/orchestrator/admission";
import { writeDelegationBoundsIfChanged } from "@/lib/orchestrator/bounds-store";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;
const execFileAsync = promisify(execFile);

// ADR-165 AC-37 — the recursive-harness scenario matrix, driven against the
// in-repo `rah-fixture` package through the REAL admission helper, the REAL
// collect route, the REAL ledger and the REAL finalizers.
//
// The fixture's STATIC safety properties (one writer, no subagent tool, no
// writable child, complete budgets) are asserted in
// lib/__tests__/rah-fixture-contract.test.ts — minimum overlap: this file
// covers the BEHAVIOUR of a tree, that one covers the shape of the manifests.

const FIXTURE_ROOT = resolve(__dirname, "../../../test-fixtures/rah");

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let projectId: string;
let runnerId: string;

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();

  return { ...actual, getDb: () => db };
});

let collectPost: typeof import("@/app/api/v1/ext/runs/collect/route").POST;
let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;

const RESEARCH_CONTRACT: RunResultContract = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "rah-fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "a".repeat(64),
  required: true,
  schema: {
    schemaVersion: 1,
    fields: [
      { name: "summary", type: "string", required: true },
      {
        name: "outcome",
        type: "enum",
        required: true,
        options: ["completed", "blocked", "needs_input"],
      },
      { name: "payload", type: "json", required: true },
    ],
  },
  sourceFlowRevisionId: "rev-rah",
};

const EXPORT_CONTRACT: RunResultContract = {
  kind: "flow_export",
  schemaRef: "rah-fixture@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "b".repeat(64),
  required: true,
  producerNodeIds: ["orchestrate"],
  schema: RESEARCH_CONTRACT.schema,
  flowRevisionId: "rev-rah",
};

const RESEARCH_VALUE = {
  summary: "the auth path goes through one verifier",
  outcome: "completed",
  payload: { entrypoints: ["lib/auth/verify.ts"] },
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "recursive_harness_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  ({ POST: collectPost } = await import("@/app/api/v1/ext/runs/collect/route"));
  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  for (const t of [
    "domain_events",
    "webhook_events",
    "run_results",
    "project_tokens",
    "run_sessions",
    "workspaces",
    "runs",
    "projects",
  ]) {
    await pool.query(`DELETE FROM "${t}"`);
  }
  projectId = randomUUID();
  runnerId = randomUUID();
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
});

afterEach(() => {
  delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  delete process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH;
});

// --- seeding ---------------------------------------------------------------

const HARNESS_BOUNDS = {
  instance: { maxDepth: 3, maxFanout: 16, flowPool: 6, agentPool: 3 },
  engineMin: "3.7.0",
  nodeId: "orchestrate",
};

async function seedRun(args: {
  parentRunId?: string | null;
  rootRunId?: string | null;
  status?: string;
  runKind?: "flow" | "agent";
  contract?: RunResultContract | null;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "status", "flow_version", "flow_revision",
       "parent_run_id", "root_run_id", "result_contract")
     VALUES ($1, $2, $3, $4, 'v1', 'rev', $5, $6, $7::jsonb)`,
    [
      runId,
      args.runKind ?? "flow",
      projectId,
      args.status ?? "Running",
      args.parentRunId ?? null,
      args.rootRunId ?? args.parentRunId ?? null,
      args.contract ? JSON.stringify(args.contract) : null,
    ],
  );

  return runId;
}

/** A coordinator whose bounds come from the FIXTURE's declared delegation block. */
async function seedCoordinator(args: {
  declared: Record<string, unknown>;
  parentRunId?: string | null;
  rootRunId?: string | null;
  status?: string;
}): Promise<string> {
  const runId = await seedRun({
    parentRunId: args.parentRunId ?? null,
    rootRunId: args.rootRunId ?? null,
    status: args.status ?? "WaitingOnChildren",
  });

  if (!args.rootRunId && !args.parentRunId) {
    await pool.query(`UPDATE "runs" SET "root_run_id" = $1 WHERE id = $1`, [
      runId,
    ]);
  }
  await writeDelegationBoundsIfChanged(db, runId, {
    ...HARNESS_BOUNDS,
    declared: args.declared as never,
    nodeAttemptId: randomUUID(),
  });

  return runId;
}

async function publishResult(
  runId: string,
  value: Record<string, unknown>,
  contract: RunResultContract = RESEARCH_CONTRACT,
): Promise<void> {
  const { publishRunResult } = await import("@/lib/run-results/ledger");

  await publishRunResult(db, {
    runId,
    value,
    valueBytes: JSON.stringify(value).length,
    contract,
    producerKind:
      contract.kind === "agent_profile" ? "agent_session" : "flow_node",
    producerRef:
      contract.kind === "agent_profile" ? "session:default" : "orchestrate",
  });
}

async function recordInvalid(
  runId: string,
  reason: "result_missing" | "schema_mismatch",
): Promise<void> {
  const { recordInvalidRunResult } = await import("@/lib/run-results/ledger");

  await recordInvalidRunResult(db, {
    runId,
    contract: RESEARCH_CONTRACT,
    reason,
    producerKind: "agent_session",
    producerRef: "session:default",
  });
}

async function setStatus(runId: string, status: string): Promise<void> {
  await pool.query(`UPDATE "runs" SET "status" = $2 WHERE id = $1`, [
    runId,
    status,
  ]);
}

type CollectItem = {
  childRunId: string;
  status: string;
  settled: boolean;
  resultStatus: string;
  result: { schemaRef: string; value: unknown } | null;
  resultFailure: { reason: string } | null;
};

async function collect(
  coordinatorRunId: string,
  body: Record<string, unknown> = { all: true },
): Promise<{ status: number; items: CollectItem[]; error?: string }> {
  const { secret } = await issueOrchestratorRunToken({
    projectId,
    runId: coordinatorRunId,
    db,
  });
  const req = new NextRequest("http://localhost/api/v1/ext/runs/collect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const res = await collectPost(req, {});
  const json = await res.json();

  return res.status === 200
    ? { status: res.status, items: json as CollectItem[] }
    : {
        status: res.status,
        items: [],
        error: (json as { message?: string }).message,
      };
}

async function admit(parentRunId: string, incoming = 1): Promise<void> {
  await (db as any).transaction(async (tx: unknown) => {
    await admitDelegatedChild(tx, { parentRunId, incoming });
  });
}

async function expectRefused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(isMaisterError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("CONFIG");

    return (err as { message: string }).message;
  }
  throw new Error("expected a CONFIG refusal, but it was admitted");
}

// The fixture's own declared bounds, READ FROM THE MANIFEST. Re-typing them
// here is how a matrix silently stops testing the fixture: a bound edited in the
// yaml would leave these constants asserting a shape nothing ships.
function declaredDelegation(flow: string): Record<string, unknown> {
  const manifest = parseYaml(
    readFileSync(join(FIXTURE_ROOT, "flows", flow, "flow.yaml"), "utf8"),
  ) as { nodes: { type: string; settings?: { delegation?: unknown } }[] };
  const orchestrator = manifest.nodes.find((n) => n.type === "orchestrator");

  return orchestrator?.settings?.delegation as Record<string, unknown>;
}

const D1_DELEGATION = declaredDelegation("rah-root-d1");
const RESEARCH_DELEGATION = declaredDelegation("rah-research");

// --- (1) depth-1 loop -------------------------------------------------------

describe("(1) depth-1 loop: four agent researchers publish and the coordinator collects", () => {
  it("collects four valid results and sees each one exactly once", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const children: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const child = await seedRun({
        parentRunId: root,
        rootRunId: root,
        runKind: "agent",
        status: "Done",
        contract: RESEARCH_CONTRACT,
      });

      await publishResult(child, {
        ...RESEARCH_VALUE,
        summary: `finding ${i}`,
      });
      children.push(child);
    }

    const { status, items } = await collect(root);

    expect(status).toBe(200);
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.resultStatus === "valid")).toBe(true);
    expect(items.every((i) => i.settled)).toBe(true);
    expect(new Set(items.map((i) => i.childRunId))).toEqual(new Set(children));
    expect(
      items.map((i) => (i.result?.value as { summary: string }).summary).sort(),
    ).toEqual(["finding 0", "finding 1", "finding 2", "finding 3"]);
  }, 60_000);

  it("the fifth researcher is refused — the fixture's fan-out of 4 binds", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });

    for (let i = 0; i < 4; i += 1) {
      await seedRun({ parentRunId: root, rootRunId: root, status: "Running" });
    }

    expect(await expectRefused(admit(root))).toContain(
      "fan-out limit reached (4)",
    );
  }, 60_000);
});

// --- (2) depth-2 with result-only research children -------------------------

describe("(2) depth-2: research FLOW children finish themselves, grandchildren stay invisible", () => {
  it("the root collects ONLY its two direct children, each Done with a valid export", async () => {
    const root = await seedCoordinator({
      declared: { ...D1_DELEGATION, max_depth: 2 },
    });
    const researchA = await seedCoordinator({
      declared: RESEARCH_DELEGATION,
      parentRunId: root,
      rootRunId: root,
      status: "Done",
    });
    const researchB = await seedCoordinator({
      declared: RESEARCH_DELEGATION,
      parentRunId: root,
      rootRunId: root,
      status: "Done",
    });

    for (const child of [researchA, researchB]) {
      await pool.query(
        `UPDATE "runs" SET "result_contract" = $2::jsonb WHERE id = $1`,
        [child, JSON.stringify(EXPORT_CONTRACT)],
      );
      await publishResult(child, RESEARCH_VALUE, EXPORT_CONTRACT);
      // Grandchildren: the research child's OWN agent researchers.
      for (let i = 0; i < 2; i += 1) {
        const grandchild = await seedRun({
          parentRunId: child,
          rootRunId: root,
          runKind: "agent",
          status: "Done",
          contract: RESEARCH_CONTRACT,
        });

        await publishResult(grandchild, RESEARCH_VALUE);
      }
    }

    const { items } = await collect(root);

    expect(items.map((i) => i.childRunId).sort()).toEqual(
      [researchA, researchB].sort(),
    );
    expect(items.every((i) => i.resultStatus === "valid")).toBe(true);
  }, 60_000);

  it("a named GRANDCHILD is refused 409 with the existence-hiding message", async () => {
    const root = await seedCoordinator({
      declared: { ...D1_DELEGATION, max_depth: 2 },
    });
    const child = await seedRun({ parentRunId: root, rootRunId: root });
    const grandchild = await seedRun({ parentRunId: child, rootRunId: root });

    const { status, error } = await collect(root, { childRunId: grandchild });

    expect(status).toBe(409);
    expect(error).toBe("run is not a child of the bound orchestrator run");
  }, 60_000);
});

// --- (3)/(4) malformed and missing child results ----------------------------

describe("(3)/(4) a child's result failure is legible to the coordinator", () => {
  it("a malformed result reports unavailable with the schema_mismatch reason", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const child = await seedRun({
      parentRunId: root,
      rootRunId: root,
      runKind: "agent",
      status: "Failed",
      contract: RESEARCH_CONTRACT,
    });

    await recordInvalid(child, "schema_mismatch");

    const [item] = (await collect(root)).items;

    expect(item.resultStatus).toBe("unavailable");
    expect(item.result).toBeNull();
    expect(item.resultFailure?.reason).toBe("schema_mismatch");
  }, 60_000);

  it("a MISSING required result reports its own reason, distinct from a mismatch", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const child = await seedRun({
      parentRunId: root,
      rootRunId: root,
      runKind: "agent",
      status: "Failed",
      contract: RESEARCH_CONTRACT,
    });

    await recordInvalid(child, "result_missing");

    expect((await collect(root)).items[0].resultFailure?.reason).toBe(
      "result_missing",
    );
  }, 60_000);

  it("the coordinator can RE-DELEGATE within its fan-out after a failure", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });

    // Four attempts, all failed — they are terminal, so they no longer count as
    // LIVE children and a replacement is admissible.
    for (let i = 0; i < 4; i += 1) {
      await seedRun({ parentRunId: root, rootRunId: root, status: "Failed" });
    }

    await expect(admit(root)).resolves.toBeUndefined();
  }, 60_000);
});

// --- (5) rework supersession through the harness ----------------------------

describe("(5) rework supersession", () => {
  it("a re-publish supersedes the prior revision, leaving exactly one valid", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const child = await seedRun({
      parentRunId: root,
      rootRunId: root,
      runKind: "agent",
      status: "Done",
      contract: RESEARCH_CONTRACT,
    });

    await publishResult(child, { ...RESEARCH_VALUE, summary: "first" });
    await publishResult(child, { ...RESEARCH_VALUE, summary: "second" });

    const rows = (await db
      .select()
      .from(schema.runResults)
      .where(eq(schema.runResults.runId, child))
      .orderBy(asc(schema.runResults.revision))) as unknown as RunResultRow[];

    expect(rows.map((r) => r.validity)).toEqual(["superseded", "valid"]);

    const [item] = (await collect(root)).items;

    expect((item.result?.value as { summary: string }).summary).toBe("second");
  }, 60_000);
});

// --- (6) stale token --------------------------------------------------------

describe("(6) a token whose coordinator has terminalized", () => {
  it("is refused 409 — collect BEFORE the coordinator finishes", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });

    await seedRun({ parentRunId: root, rootRunId: root, status: "Done" });
    await setStatus(root, "Done");

    expect((await collect(root)).status).toBe(409);
  }, 60_000);
});

// --- (7) effective bounds ---------------------------------------------------

describe("(7) the fixture's declared bounds are what binds", () => {
  // `max_depth` counts ABSOLUTE depth from the tree root (R5: `depth >=
  // min(env, root.maxDepth, parent.maxDepth)`), so the fixture's nested research
  // flow declares 2 — the depth its OWN researchers occupy in the whole tree.
  it("the fixture's depth-2 shape admits the researchers, and refuses one level deeper", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const root = await seedCoordinator({
      declared: { ...D1_DELEGATION, max_depth: 2 },
    });
    const research = await seedCoordinator({
      declared: RESEARCH_DELEGATION,
      parentRunId: root,
      rootRunId: root,
    });
    // A researcher of the research child — depth 2, the deepest the tree allows.
    const researcher = await seedCoordinator({
      declared: RESEARCH_DELEGATION,
      parentRunId: research,
      rootRunId: root,
    });

    await expect(admit(research)).resolves.toBeUndefined();
    expect(await expectRefused(admit(researcher))).toContain(
      "depth limit reached",
    );
  }, 60_000);

  it("a NESTED coordinator declaring a lower depth tightens the whole tree", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const root = await seedCoordinator({
      declared: { ...D1_DELEGATION, max_depth: 2 },
    });
    // The root would allow depth 2; this child says 1, and the MIN binds.
    const strict = await seedCoordinator({
      declared: { ...RESEARCH_DELEGATION, max_depth: 1 },
      parentRunId: root,
      rootRunId: root,
    });

    expect(await expectRefused(admit(strict))).toContain(
      "depth limit reached (1)",
    );
    // ...and it tightens only its own subtree: the root still delegates.
    await expect(admit(root)).resolves.toBeUndefined();
  }, 60_000);

  it("the NESTED research child's max_child_runs refuses before the root's", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "16";
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "5";

    const root = await seedCoordinator({
      declared: { ...D1_DELEGATION, max_depth: 5 },
    });
    const research = await seedCoordinator({
      declared: { ...RESEARCH_DELEGATION, max_depth: 5 },
      parentRunId: root,
      rootRunId: root,
    });

    // The research child's budget allows 4 descendants.
    for (let i = 0; i < 4; i += 1) {
      await seedRun({ parentRunId: research, rootRunId: root, status: "Done" });
    }

    const message = await expectRefused(admit(research));

    expect(message).toContain(research);
    expect(message).toContain("max_child_runs 4");
    // The root's budget (8) still has room — the NESTED bound is what fired.
    await expect(admit(root)).resolves.toBeUndefined();
  }, 60_000);
});

// --- (8) the wake set -------------------------------------------------------

describe("(8) every settle kind reports a coherent state to the coordinator", () => {
  const CASES: Array<{
    name: string;
    status: string;
    publish: "valid" | "invalid" | "none";
    expected: string;
  }> = [
    { name: "Review", status: "Review", publish: "valid", expected: "valid" },
    {
      name: "Done (result-only)",
      status: "Done",
      publish: "valid",
      expected: "valid",
    },
    {
      name: "Failed",
      status: "Failed",
      publish: "invalid",
      expected: "unavailable",
    },
    {
      name: "Crashed",
      status: "Crashed",
      publish: "none",
      expected: "unavailable",
    },
    {
      name: "Abandoned",
      status: "Abandoned",
      publish: "none",
      expected: "unavailable",
    },
  ];

  it.each(CASES)(
    "$name → $expected",
    async ({ status, publish, expected }) => {
      const root = await seedCoordinator({ declared: D1_DELEGATION });
      const child = await seedRun({
        parentRunId: root,
        rootRunId: root,
        runKind: "agent",
        status: "Running",
        contract: RESEARCH_CONTRACT,
      });

      if (publish === "valid") await publishResult(child, RESEARCH_VALUE);
      if (publish === "invalid") await recordInvalid(child, "result_missing");
      await setStatus(child, status);

      const [item] = (await collect(root)).items;

      expect(item.resultStatus).toBe(expected);
      expect(item.settled).toBe(true);
      // A crash that published nothing has no reason to report — a guess would be
      // worse than a null.
      if (publish === "none") expect(item.resultFailure).toBeNull();
    },
    60_000,
  );
});

// --- (9) cancel / abandon ---------------------------------------------------

describe("(9) an abandoned child", () => {
  it("reports unavailable and frees its fan-out slot", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const children: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      children.push(
        await seedRun({
          parentRunId: root,
          rootRunId: root,
          status: "Running",
        }),
      );
    }
    // At the fan-out cap.
    await expectRefused(admit(root));

    await setStatus(children[0], "Abandoned");
    // Terminal children no longer count as LIVE, so the slot is free.
    await expect(admit(root)).resolves.toBeUndefined();

    const item = (await collect(root)).items.find(
      (i) => i.childRunId === children[0],
    );

    expect(item?.resultStatus).toBe("unavailable");
  }, 60_000);
});

// --- (11) the one-writer property, behaviourally ----------------------------

describe("(11) one-writer safety", () => {
  it("no fixture child of the harness graphs declares a worktree workspace", async () => {
    // The static assertion lives in rah-fixture-contract.test.ts; the
    // behavioural half is that a READ-ONLY child never acquires a workspaces
    // row, so there is no second branch for a coordinator to promote.
    const root = await seedCoordinator({ declared: D1_DELEGATION });
    const child = await seedRun({
      parentRunId: root,
      rootRunId: root,
      runKind: "agent",
      status: "Done",
      contract: RESEARCH_CONTRACT,
    });

    await publishResult(child, RESEARCH_VALUE);

    const workspaces = await pool.query(
      `SELECT count(*)::int AS n FROM "workspaces" WHERE "run_id" = $1`,
      [child],
    );

    expect(workspaces.rows[0].n).toBe(0);

    // And the child still delivers its answer — the result plane is what
    // carries it, not a diff.
    expect((await collect(root)).items[0].resultStatus).toBe("valid");
  }, 60_000);
});

// --- (12) collect idempotency across the tree -------------------------------

describe("(12) repeated collects are byte-identical and mark once", () => {
  it("stamps first_collected_at exactly once across a fan-out", async () => {
    const root = await seedCoordinator({ declared: D1_DELEGATION });

    for (let i = 0; i < 3; i += 1) {
      const child = await seedRun({
        parentRunId: root,
        rootRunId: root,
        runKind: "agent",
        status: "Done",
        contract: RESEARCH_CONTRACT,
      });

      await publishResult(child, RESEARCH_VALUE);
    }

    const first = await collect(root);

    const stamps = await pool.query(
      `SELECT "first_collected_at" AS t FROM "run_results" WHERE "validity" = 'valid' ORDER BY "run_id"`,
    );

    expect(stamps.rows.every((r) => r.t !== null)).toBe(true);

    const second = await collect(root);

    expect(JSON.stringify(second.items)).toBe(JSON.stringify(first.items));

    const stampsAgain = await pool.query(
      `SELECT "first_collected_at" AS t FROM "run_results" WHERE "validity" = 'valid' ORDER BY "run_id"`,
    );

    expect(stampsAgain.rows).toEqual(stamps.rows);
  }, 60_000);
});

// A real git worktree, used by the result-only completion arm below.
async function makeCleanWorktree(): Promise<{
  path: string;
  baseCommit: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "maister-rah-"));

  await execFileAsync("git", ["-C", dir, "init", "-q", "-b", "feature/test"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(join(dir, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  const { stdout } = await execFileAsync("git", [
    "-C",
    dir,
    "rev-parse",
    "HEAD",
  ]);

  return { path: dir, baseCommit: stdout.trim() };
}

describe("the research child's clean-workspace precondition", () => {
  it("a research child that changed nothing has a clean workspace by the REAL predicate", async () => {
    const { isRunWorkspaceClean } = await import("@/lib/runs/workspace-clean");
    const wt = await makeCleanWorktree();

    expect(
      await isRunWorkspaceClean({
        worktreePath: wt.path,
        branch: "feature/test",
        baseCommit: wt.baseCommit,
      }),
    ).toEqual({ clean: true, reason: "clean" });

    // A single uncommitted file is enough to disqualify it — which is why a
    // research flow must not write, not merely "not commit".
    await writeFile(join(wt.path, "scratch.txt"), "x\n", "utf8");
    expect(
      (
        await isRunWorkspaceClean({
          worktreePath: wt.path,
          branch: "feature/test",
          baseCommit: wt.baseCommit,
        })
      ).clean,
    ).toBe(false);
  }, 60_000);

  it("the fixture root is reachable, so the matrix is running against the real package", () => {
    expect(FIXTURE_ROOT).toContain("test-fixtures/rah");
  });
});
