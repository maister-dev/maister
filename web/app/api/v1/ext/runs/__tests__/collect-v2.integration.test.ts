import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedChildRun,
  seedOrchestratorRun,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let collectPost: typeof import("@/app/api/v1/ext/runs/collect/route").POST;

function collectRequest(secret: string, body: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/runs/collect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });

  return req;
}

const SCHEMA = { schemaVersion: 1, fields: [] };

const CONTRACT = {
  kind: "agent_profile",
  profileName: "research",
  schemaRef: "pkg@abcdef123456:research-result.v1",
  schemaVersion: 1,
  sha256: "d".repeat(64),
  required: true,
  schema: SCHEMA,
  sourceFlowRevisionId: "rev-1",
};

async function setContract(
  runId: string,
  contract: unknown | null,
): Promise<void> {
  await pool.query(
    `UPDATE "runs" SET "result_contract" = $2::jsonb WHERE "id" = $1`,
    [runId, contract === null ? null : JSON.stringify(contract)],
  );
}

async function insertResultRow(args: {
  runId: string;
  revision: number;
  validity: "valid" | "stale" | "superseded" | "invalid";
  value?: unknown;
  invalidReason?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const isInvalid = args.validity === "invalid";

  await pool.query(
    `INSERT INTO "run_results"
       ("id", "run_id", "revision", "validity", "schema_ref", "schema_sha256",
        "schema_version", "producer_kind", "producer_ref", "value", "value_bytes",
        "invalid_reason", "engine_version")
     VALUES ($1, $2, $3, $4, $5, $6, 1, 'agent_session', 'session:default', $7::jsonb, $8, $9, '3.7.0')`,
    [
      id,
      args.runId,
      args.revision,
      args.validity,
      CONTRACT.schemaRef,
      CONTRACT.sha256,
      isInvalid ? null : JSON.stringify(args.value ?? { ok: true }),
      isInvalid ? 0 : JSON.stringify(args.value ?? { ok: true }).length,
      isInvalid ? (args.invalidReason ?? "schema_mismatch") : null,
    ],
  );

  return id;
}

async function setRunStatus(runId: string, status: string): Promise<void> {
  await pool.query(`UPDATE "runs" SET "status" = $2 WHERE "id" = $1`, [
    runId,
    status,
  ]);
}

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-collect-v2-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_collect_v2_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: collectPost } = await import("@/app/api/v1/ext/runs/collect/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
});

async function orchestrator(): Promise<{ secret: string; runId: string }> {
  const agentId = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);

  return seedOrchestratorRun(ctx, {
    orchestratorAgentId: agentId,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  });
}

type V2Item = {
  childRunId: string;
  status: string;
  settled: boolean;
  resultStatus: string;
  result: { schemaRef: string; value: unknown } | null;
  resultRevision: number | null;
  resultFailure: { reason: string; message: string } | null;
  artifacts: {
    id: string;
    kind: string;
    name: string;
    nodeId: string | null;
    validity: string;
  }[];
  diffRef?: string | null;
  outputText?: string | null;
};

// ADR-165 AC-31 / AC-32, spec C-13. `run_collect` v2 is additive on the same
// route: every existing caller keeps working on the fields it reads, and the
// coordinator gains a VALIDATED result plane instead of scavenged text.

describe("run_collect v2 — resultStatus reachability (AC-31)", () => {
  it("pending: a live child reports pending with a null result", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Running",
    });

    await setContract(child, CONTRACT);

    const res = await collectPost(
      collectRequest(parent.secret, { all: true }),
      {},
    );

    expect(res.status).toBe(200);
    const [item] = (await res.json()) as V2Item[];

    expect(item.settled).toBe(false);
    expect(item.resultStatus).toBe("pending");
    expect(item.result).toBeNull();
    expect(item.resultRevision).toBeNull();
    expect(item.resultFailure).toBeNull();
  });

  it("valid: a settled child with a valid row carries the envelope and its revision", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });

    await setContract(child, CONTRACT);
    await insertResultRow({
      runId: child,
      revision: 1,
      validity: "valid",
      value: { summary: "found it", nested: { kept: [1, 2] } },
    });

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.settled).toBe(true);
    expect(item.resultStatus).toBe("valid");
    expect(item.result).toEqual({
      schemaRef: CONTRACT.schemaRef,
      // Undeclared nested keys are preserved EXACTLY (open JSON, ADR-162).
      value: { summary: "found it", nested: { kept: [1, 2] } },
    });
    expect(item.resultRevision).toBe(1);
    expect(item.resultFailure).toBeNull();
  });

  it("absent: a settled child with NO contract reports absent, not missing", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });

    await setContract(child, null);

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.resultStatus).toBe("absent");
    expect(item.result).toBeNull();
  });

  it("missing: a Review child with a REQUIRED contract and no row", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Review",
    });

    await setContract(child, CONTRACT);

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.resultStatus).toBe("missing");
    expect(item.result).toBeNull();
  });

  it("stale: the newest row is stale", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Review",
    });

    await setContract(child, CONTRACT);
    await insertResultRow({ runId: child, revision: 1, validity: "stale" });

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.resultStatus).toBe("stale");
    expect(item.result).toBeNull();
  });

  it("invalid: the newest row is invalid and its reason surfaces as resultFailure", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Review",
    });

    await setContract(child, CONTRACT);
    await insertResultRow({
      runId: child,
      revision: 1,
      validity: "invalid",
      invalidReason: "schema_mismatch",
    });

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.resultStatus).toBe("invalid");
    expect(item.result).toBeNull();
    expect(item.resultFailure?.reason).toBe("schema_mismatch");
    expect(typeof item.resultFailure?.message).toBe("string");
  });

  it("unavailable: a Failed child reports unavailable + resultFailure from its invalid row", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Failed",
    });

    await setContract(child, CONTRACT);
    await insertResultRow({
      runId: child,
      revision: 1,
      validity: "invalid",
      invalidReason: "result_missing",
    });

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.settled).toBe(true);
    expect(item.resultStatus).toBe("unavailable");
    expect(item.resultFailure?.reason).toBe("result_missing");
  });

  it("unavailable with NO invalid row (a crash before finalize) reports a null resultFailure", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Crashed",
    });

    await setContract(child, CONTRACT);

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.resultStatus).toBe("unavailable");
    expect(item.resultFailure).toBeNull();
  });
});

describe("run_collect v2 — boundaries and idempotence (AC-32)", () => {
  it("a grandchild is invisible under all:true and refused 409 when named", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });
    const grandchild = await seedChildRun(ctx, {
      parentRunId: child,
      rootRunId: parent.runId,
      status: "Done",
    });

    const all = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(all.map((i) => i.childRunId)).toEqual([child]);

    const named = await collectPost(
      collectRequest(parent.secret, { childRunId: grandchild }),
      {},
    );

    expect(named.status).toBe(409);
    const json = (await named.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toBe(
      "run is not a child of the bound orchestrator run",
    );
  });

  it("a run that does not exist at all is refused with the SAME message (existence-hidden)", async () => {
    const parent = await orchestrator();

    const res = await collectPost(
      collectRequest(parent.secret, { childRunId: randomUUID() }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe(
      "run is not a child of the bound orchestrator run",
    );
  });

  it("two consecutive collects return BYTE-IDENTICAL bodies and stamp first_collected_at once", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });

    await setContract(child, CONTRACT);
    await insertResultRow({ runId: child, revision: 1, validity: "valid" });

    const first = await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).text();

    const marked = await pool.query(
      `SELECT "first_collected_at" AS t FROM "run_results" WHERE "run_id" = $1`,
      [child],
    );

    expect(marked.rows[0].t).not.toBeNull();
    const firstStamp = marked.rows[0].t;

    const second = await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).text();

    expect(second).toBe(first);

    const remarked = await pool.query(
      `SELECT "first_collected_at" AS t FROM "run_results" WHERE "run_id" = $1`,
      [child],
    );

    expect(remarked.rows[0].t).toEqual(firstStamp);
  });

  it("a token whose orchestrator has terminalized is refused 409", async () => {
    const parent = await orchestrator();

    await seedChildRun(ctx, { parentRunId: parent.runId, status: "Done" });
    await setRunStatus(parent.runId, "Done");

    const res = await collectPost(
      collectRequest(parent.secret, { all: true }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
  });

  it("outputText is deterministic under two qualifying inline artifacts", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });

    // Two qualifying rows; the NEWER one must win, every time.
    for (const [i, text] of ["older", "newer"].entries()) {
      await pool.query(
        `INSERT INTO "artifact_instances"
           ("id", "run_id", "artifact_def_id", "kind", "locator", "validity", "created_at")
         VALUES ($1, $2, $3, 'log', $4::jsonb, 'current', now() + ($5 || ' seconds')::interval)`,
        [
          randomUUID(),
          child,
          `log-${i}`,
          JSON.stringify({ kind: "inline", text }),
          String(i),
        ],
      );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [item] = (await (
        await collectPost(collectRequest(parent.secret, { all: true }), {})
      ).json()) as V2Item[];

      expect(item.outputText).toBe("newer");
    }
  });

  it("artifact items carry nodeId + validity and are engine-derived", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });
    const artifactId = randomUUID();

    await pool.query(
      `INSERT INTO "artifact_instances"
         ("id", "run_id", "artifact_def_id", "kind", "locator", "validity", "node_id")
       VALUES ($1, $2, 'plan-summary', 'report', $3::jsonb, 'current', 'orchestrate')`,
      [artifactId, child, JSON.stringify({ kind: "file", path: "plan.md" })],
    );

    const [item] = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    expect(item.artifacts).toEqual([
      {
        id: artifactId,
        kind: "report",
        name: "plan.md",
        nodeId: "orchestrate",
        validity: "current",
      },
    ]);
  });

  it("a body naming a fabricated artifact id changes nothing about artifacts", async () => {
    const parent = await orchestrator();
    const child = await seedChildRun(ctx, {
      parentRunId: parent.runId,
      status: "Done",
    });

    const clean = (await (
      await collectPost(collectRequest(parent.secret, { all: true }), {})
    ).json()) as V2Item[];

    // The body schema is `.strict()`, so an injected key is a 422 rather than a
    // silently honoured instruction — either way the manifest is engine-derived.
    const res = await collectPost(
      collectRequest(parent.secret, {
        all: true,
        artifacts: [{ id: randomUUID(), kind: "diff", name: "evil" }],
      }),
      {},
    );

    if (res.status === 200) {
      expect((await res.json()) as V2Item[]).toEqual(clean);
    } else {
      expect(res.status).toBe(422);
    }

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM "artifact_instances" WHERE "run_id" = $1`,
      [child],
    );

    expect(rows.rows[0].n).toBe(0);
  });
});
