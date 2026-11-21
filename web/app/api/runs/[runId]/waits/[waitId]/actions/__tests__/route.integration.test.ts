import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

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

async function seedOperatorWait() {
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
          on: { kind: "timer", after: 60 },
          transitions: { elapsed: "done", timeout: "done", cancelled: "done" },
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
  return { runId, projectId, wait };
}

it("W09 authorizes and audits one resolve-now, including mixed-credential and viewer refusals", async () => {
  const { POST } = await import("../route");
  const { runId, projectId, wait } = await seedOperatorWait();
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
  const { runId, projectId, wait } = await seedOperatorWait();

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
