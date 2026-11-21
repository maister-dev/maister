import type { z } from "zod";
import type { waitConditionSchema } from "@/lib/waits/manifest";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";

import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let userId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({ auth: () => ({ user: { id: userId } }) }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "wait_operator_actions",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

const timer = { kind: "timer", after: 60 } as const;

async function seedOperatorWait(
  on: z.input<typeof waitConditionSchema>,
  matchedOutcome: string,
) {
  const { runFlow } = await import("@/lib/flows/runner");
  const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Operator wait",
      compat: { engine_min: "3.13.0" },
      nodes: [
        {
          type: "wait",
          id: "verify",
          timeout: 120,
          on,
          transitions: {
            [matchedOutcome]: "done",
            timeout: "done",
            cancelled: "done",
          },
        },
      ],
    },
  );

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });

  userId = randomUUID();
  await database.pool.query(
    "INSERT INTO users (id,email,role,account_status) VALUES ($1,$2,'member','active')",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members (id,project_id,user_id,role) VALUES (gen_random_uuid()::text,$1,$2,'viewer')",
    [projectId, userId],
  );

  const { hosts } = await fakeGraphHosts(database.db, runId);

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

  const {
    rows: [wait],
  } = await database.pool.query<{ id: string; version: number }>(
    "SELECT id,version FROM run_waits WHERE run_id=$1",
    [runId],
  );
  return { runId, projectId, wait, hosts };
}

it("W09 authorizes and audits one resolve-now, including mixed-credential and viewer refusals", async () => {
  const { POST } = await import("../route");
  const { runId, projectId, wait } = await seedOperatorWait(timer, "elapsed");
  const origin = process.env.AUTH_URL
    ? new URL(process.env.AUTH_URL).origin
    : "http://localhost";
  let currentVersion = wait.version;
  const operate = (reason: string, credentials?: string) =>
    POST(
      new Request(`${origin}/api/runs/${runId}/waits/${wait.id}/actions`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "action-1",
          ...(credentials ? { authorization: credentials } : {}),
        },
        body: JSON.stringify({
          action: "resolve_now",
          expectedVersion: currentVersion,
          reason,
          outcome: "elapsed",
        }),
      }),
      { params: Promise.resolve({ runId, waitId: wait.id }) },
    );

  expect((await operate("confirmed", "Bearer token-from-ci")).status).toBe(403);
  expect((await operate("confirmed")).status).toBe(403);
  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE user_id=$1 AND project_id=$2",
    [userId, projectId],
  );

  const extend = await POST(
    new Request(`${origin}/api/runs/${runId}/waits/${wait.id}/actions`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "idempotency-key": "action-extend",
      },
      body: JSON.stringify({
        action: "extend",
        expectedVersion: currentVersion,
        reason: "CI needs another minute",
        deadline: new Date(Date.now() + 180_000).toISOString(),
      }),
    }),
    { params: Promise.resolve({ runId, waitId: wait.id }) },
  );

  expect(extend.status).toBe(200);
  const extension = await extend.json();

  expect(extension).toMatchObject({ state: "open", version: wait.version + 1 });
  currentVersion = extension.version;

  const applied = await operate("confirmed");

  expect(applied.status).toBe(200);
  const receipt = await applied.json();

  expect(receipt).toEqual({
    actionReceiptId: expect.any(String),
    version: currentVersion + 1,
    state: "resolved",
    outcome: "elapsed",
  });
  expect(await (await operate("confirmed")).json()).toEqual(receipt);
  expect((await operate("different reason")).status).toBe(409);
  const { rows } = await database.pool.query(
    "SELECT user_id,reason,response FROM run_wait_actions WHERE wait_id=$1 ORDER BY created_at, id",
    [wait.id],
  );

  expect(rows).toEqual([
    { user_id: userId, reason: "CI needs another minute", response: extension },
    { user_id: userId, reason: "confirmed", response: receipt },
  ]);

  // Force two keyset pages within the same millisecond. A JavaScript Date
  // round-trip would skip the last row even though its receipt remains durable.
  await database.pool.query(
    `INSERT INTO run_wait_deliveries (
      id,wait_id,source_kind,source_id,idempotency_key,payload_digest,body,received_at,disposition,application,reason
    ) SELECT lpad(to_hex(n),64,'0'),$1,'operator',$2,n::text,lpad(to_hex(n),64,'0'),
      '{"name":"build","outcome":"success"}', '2026-01-01T00:00:00Z'::timestamptz+n*interval '1 microsecond',
      'rejected','not_applied','wait_invalid_payload' FROM generate_series(1,21) n`,
    [wait.id, userId],
  );
  const { GET } = await import("../../route");
  const inspect = async (cursor?: string) =>
    GET(
      new Request(
        `${origin}/api/runs/${runId}/waits/${wait.id}${
          cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      ),
      { params: Promise.resolve({ runId, waitId: wait.id }) },
    );
  const firstPage = await inspect();

  expect(firstPage.status).toBe(200);
  const first = await firstPage.json();

  expect(first.deliveries).toHaveLength(20);
  const older = await (await inspect(first.nextCursor)).json();

  expect(older).toMatchObject({
    nextCursor: null,
    deliveries: [
      { id: "1".padStart(64, "0"), receivedAt: "2026-01-01T00:00:00.000001Z" },
    ],
  });
});

it("W09 cancels through the operator route only against the current version", async () => {
  const { POST } = await import("../route");
  const { runId, projectId, wait } = await seedOperatorWait(timer, "elapsed");

  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE user_id=$1 AND project_id=$2",
    [userId, projectId],
  );
  const origin = process.env.AUTH_URL
    ? new URL(process.env.AUTH_URL).origin
    : "http://localhost";
  const cancel = (expectedVersion: number) =>
    POST(
      new Request(`${origin}/api/runs/${runId}/waits/${wait.id}/actions`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": "cancel-wait",
        },
        body: JSON.stringify({
          action: "cancel",
          expectedVersion,
          reason: "The operator withdrew verification.",
        }),
      }),
      { params: Promise.resolve({ runId, waitId: wait.id }) },
    );

  expect((await cancel(wait.version + 1)).status).toBe(409);
  const applied = await cancel(wait.version);

  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({
    state: "resolved",
    outcome: "cancelled",
  });
  const { rows } = await database.pool.query(
    "SELECT user_id,action,reason FROM run_wait_actions WHERE wait_id=$1",
    [wait.id],
  );

  expect(rows).toEqual([
    {
      user_id: userId,
      action: "cancel",
      reason: "The operator withdrew verification.",
    },
  ]);
});

it("W09 exposes signal data only through its audience-checked projection", async () => {
  const { POST } = await import("../route");
  const { GET: inspect } = await import("../../route");
  const { GET: artifactPayload } =
    await import("../../../../artifacts/[artifactId]/payload/route");
  const { resolveObservedWait } = await import("@/lib/waits/resolve");
  const { runId, projectId, wait, hosts } = await seedOperatorWait(
    { kind: "signal", name: "build", outcomes: ["success"] },
    "success",
  );
  const origin = process.env.AUTH_URL
    ? new URL(process.env.AUTH_URL).origin
    : "http://localhost";
  const resource = `${origin}/api/runs/${runId}/waits/${wait.id}`;
  const context = { params: Promise.resolve({ runId, waitId: wait.id }) };
  const data = { summary: "{{ task.prompt }} -- source data" };

  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE user_id=$1 AND project_id=$2",
    [userId, projectId],
  );
  const delivered = await POST(
    new Request(`${resource}/actions`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "idempotency-key": "manual-payload",
      },
      body: JSON.stringify({
        action: "deliver_signal",
        expectedVersion: wait.version,
        reason: "CI delivery is missing.",
        signal: { name: "build", outcome: "success", payload: data },
      }),
    }),
    context,
  );

  expect(delivered.status).toBe(202);
  expect(
    await resolveObservedWait(
      database.db,
      { runId, projectId, waitId: wait.id },
      hosts,
    ),
  ).toBe(true);
  const member = await inspect(new Request(resource), context);

  expect(member.status).toBe(200);
  expect(await member.json()).toMatchObject({
    result: { data, redacted: false },
  });
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE user_id=$1 AND project_id=$2",
    [userId, projectId],
  );
  const viewer = await inspect(new Request(resource), context);

  expect(viewer.status).toBe(200);
  expect((await viewer.json()).result).toEqual({
    outcome: "success",
    source: "signal",
    redacted: true,
  });
  const {
    rows: [{ id: artifactId }],
  } = await database.pool.query<{ id: string }>(
    "SELECT id FROM artifact_instances WHERE run_id=$1 AND kind='wait-result'",
    [runId],
  );
  const url = `${origin}/api/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/payload`;

  for (const query of ["", "?view=preview"]) {
    const artifact = await artifactPayload(new Request(url + query), {
      params: Promise.resolve({ runId, artifactId }),
    });

    expect(artifact.status).toBe(200);
    const envelope = JSON.parse(await artifact.text());

    expect(envelope).toMatchObject({
      outcome: "success",
      dataRestricted: true,
    });
    expect(envelope).not.toHaveProperty("data");
  }
});

it.each(["extend", "timeout"] as const)(
  "W05 serializes an extension and a deadline sweep when %s wins",
  async (first) => {
    const { extendWaitDeadline, extendWaitDeadlineInTransaction } =
      await import("@/lib/waits/store");
    const { resolveEligibleConditionWait } =
      await import("@/lib/waits/lifecycle");
    const { resolveObservedWait } = await import("@/lib/waits/resolve");
    const { runId, projectId, wait, hosts } = await seedOperatorWait(
      { kind: "signal", name: "build", outcomes: ["success"] },
      "success",
    );
    const address = { runId, projectId, waitId: wait.id };
    const {
      rows: [{ deadline_at: originalDeadline }],
    } = await database.pool.query<{ deadline_at: Date }>(
      `UPDATE run_waits
       SET deadline_at=greatest(opened_at,statement_timestamp()+($2::int*interval '1 second')),
           next_due_at=greatest(opened_at,statement_timestamp()+($2::int*interval '1 second'))
       WHERE id=$1 RETURNING deadline_at`,
      [wait.id, first === "extend" ? 3 : -1],
    );
    const extension = {
      ...address,
      userId,
      idempotencyKey: "deadline-race",
      expectedVersion: wait.version,
      reason: "Verification needs more time.",
      deadline: new Date(originalDeadline.getTime() + 60_000),
    };
    let entered!: (pid: number) => void;
    let release!: () => void;
    const ready = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const winner = database.db.transaction(async (tx) => {
      const {
        rows: [{ pid }],
      } = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );

      if (first === "extend")
        await extendWaitDeadlineInTransaction(tx, extension);
      else expect(await resolveEligibleConditionWait(tx, address)).toBe(true);
      entered(pid);
      await hold;
    });
    const pid = await Promise.race([
      ready,
      winner.then(() => {
        throw new Error("Winner did not hold the wait");
      }),
    ]);

    try {
      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ due: boolean }>(
                "SELECT next_due_at<=clock_timestamp() AS due FROM run_waits WHERE id=$1",
                [wait.id],
              )
            ).rows[0].due,
          { timeout: 10_000 },
        )
        .toBe(true);
      const rival =
        first === "extend"
          ? resolveObservedWait(database.db, address, hosts)
          : extendWaitDeadline(database.db, extension).catch(
              (error: unknown) => error,
            );

      await expect
        .poll(
          async () =>
            (
              await database.pool.query<{ blocked: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              )
            ).rows[0].blocked,
        )
        .toBe(true);
      release();
      await winner;
      if (first === "extend") expect(await rival).toBe(false);
      else
        expect(await rival).toMatchObject({
          code: "CONFLICT",
          details: { reason: "wait_closed" },
        });
    } finally {
      release();
    }
    const { rows } = await database.pool.query(
      `SELECT w.state,w.version,w.result->>'outcome' AS outcome,
      (SELECT count(*)::int FROM run_wait_actions a WHERE a.wait_id=w.id) AS actions
      FROM run_waits w WHERE w.id=$1`,
      [wait.id],
    );

    expect(rows).toEqual([
      {
        state: first === "extend" ? "open" : "resolved",
        version: wait.version + 1,
        outcome: first === "extend" ? null : "timeout",
        actions: first === "extend" ? 1 : 0,
      },
    ]);
  },
);
