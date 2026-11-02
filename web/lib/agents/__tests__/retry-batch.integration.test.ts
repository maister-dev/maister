import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  acceptAgentRetryBatch,
  getAgentRetryBatchOptions,
} from "@/lib/agents/retry-batch";
import { prepareUndispatchedAgentFailure } from "@/lib/agents/finalization";
import { runs, runSessions } from "@/lib/db/schema";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const previousRoot = process.env.MAISTER_WORKTREES_ROOT;
const previousSecret = process.env.AUTH_SECRET;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "agent_retry_batch",
  });
  root = await mkdtempReal("agent-retry-batch-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.AUTH_SECRET = "retry-batch-test-cursor-secret";
  await fakeExecutionHosts(database.db);
}, 180_000);

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  if (previousSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = previousSecret;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{
  projectId: string;
  agentId: string;
  userId: string;
  runnerId: string;
  runId: string;
}> {
  const runId = await seedAgentRun(database.db, {
    runtimeRoot: root,
    definition:
      "---\nname: Inspector\ndescription: inspect\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect the task.",
    workspace: "none",
    resultContract: null,
  });
  const [run] = await database.db.select().from(runs).where(eq(runs.id, runId));
  const [session] = await database.db
    .select()
    .from(runSessions)
    .where(eq(runSessions.runId, runId));
  const userId = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES ($1,$2,'member','active',false)",
    [userId, `${userId}@example.test`],
  );
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), run.projectId, userId],
  );
  await database.pool.query(
    "INSERT INTO platform_runtime_settings(id,default_runner_id) VALUES ('singleton',$1) ON CONFLICT(id) DO UPDATE SET default_runner_id=excluded.default_runner_id",
    [session.runnerId],
  );
  const failure = await prepareUndispatchedAgentFailure(runId, {
    db: database.db,
    reason: "agent_dispatch_failed",
  });

  await database.db.transaction(failure.apply);

  return {
    projectId: run.projectId!,
    agentId: run.agentId!,
    userId,
    runnerId: session.runnerId!,
    runId,
  };
}

it("previews scoped failures, accepts independent keyed items, and reconciles lost batch responses without duplicate intents", async () => {
  const source = await fixture();
  const secondId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',$2::text))).* FROM runs r WHERE r.id=$1",
    [source.runId, secondId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,run_id,actor_type,occurred_at,payload) VALUES ('run.failed',$1,$2,'system',now(),$3)",
    [
      source.projectId,
      secondId,
      { cause: { source: "agent", reason: "agent_dispatch_failed" } },
    ],
  );
  const options = await getAgentRetryBatchOptions(database.db, source);

  expect(options.items.map((item) => item.runId).sort()).toEqual(
    [source.runId, secondId].sort(),
  );
  expect(options.items.every((item) => item.options?.eligible)).toBe(true);
  expect(options.selectedRunnerId).toBe(source.runnerId);
  const body = {
    runnerId: source.runnerId,
    items: options.items.map((item) => ({
      runId: item.runId,
      requestKey: randomUUID(),
      previewFingerprint: item.options!.previewFingerprint,
      strategy: item.options!.strategy,
    })),
  };
  const first = await acceptAgentRetryBatch(database.db, source, body);
  const replay = await acceptAgentRetryBatch(database.db, source, body);

  expect(first.items.map((item) => item.state)).toEqual([
    "accepted",
    "accepted",
  ]);
  expect(replay).toEqual(first);
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_retry_intents WHERE project_id=$1",
        [source.projectId],
      )
    ).rows,
  ).toHaveLength(2);
  await expect(
    acceptAgentRetryBatch(database.db, source, {
      ...body,
      items: [body.items[0], body.items[0]],
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
});

it("rejects a foreign source before accepting any prefix and reports per-item precondition refusals", async () => {
  const source = await fixture();
  const foreign = await fixture();
  const preview = await getAgentRetryBatchOptions(database.db, source, {
    runIds: [source.runId],
  });
  const request = {
    runnerId: source.runnerId,
    items: [source.runId, foreign.runId].map((runId) => ({
      runId,
      requestKey: randomUUID(),
      previewFingerprint: preview.items[0].options!.previewFingerprint,
      strategy: preview.items[0].options!.strategy,
    })),
  };

  await expect(
    acceptAgentRetryBatch(database.db, source, request),
  ).rejects.toMatchObject({
    details: { reason: "retry_batch_source_unavailable" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_retry_intents WHERE project_id=$1",
        [source.projectId],
      )
    ).rows,
  ).toHaveLength(0);
  const result = await acceptAgentRetryBatch(database.db, source, {
    ...request,
    items: [{ ...request.items[0], previewFingerprint: "0".repeat(64) }],
  });

  expect(result.items[0]).toMatchObject({
    state: "refused",
    reason: "retry_preview_stale",
    receipt: null,
  });
});

it("deduplicates selected failures for one task and checks launch authority before preview", async () => {
  const source = await fixture();
  const taskId = randomUUID();
  const secondId = randomUUID();

  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt) VALUES ($1,$2,1,'Current request','Inspect current inputs')",
    [taskId, source.projectId],
  );
  await database.pool.query("UPDATE runs SET task_id=$2 WHERE id=$1", [
    source.runId,
    taskId,
  ]);
  await database.pool.query(
    "INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',$2::text))).* FROM runs r WHERE r.id=$1",
    [source.runId, secondId],
  );
  await database.pool.query(
    "INSERT INTO domain_events(kind,project_id,run_id,actor_type,occurred_at,payload) VALUES ('run.failed',$1,$2,'system',now(),$3)",
    [
      source.projectId,
      secondId,
      { cause: { source: "agent", reason: "agent_dispatch_failed" } },
    ],
  );
  await expect(
    getAgentRetryBatchOptions(database.db, { ...source, userId: randomUUID() }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  const preview = await getAgentRetryBatchOptions(database.db, source);

  expect(preview.items.filter((item) => item.options?.eligible)).toHaveLength(
    1,
  );
  expect(
    preview.items.filter((item) => item.reason === "retry_duplicate_task"),
  ).toHaveLength(1);
  const results = await acceptAgentRetryBatch(database.db, source, {
    runnerId: source.runnerId,
    items: preview.items.map((item) => ({
      runId: item.runId,
      requestKey: randomUUID(),
      previewFingerprint: item.options!.previewFingerprint,
      strategy: item.options!.strategy,
    })),
  });

  expect(results.items.map((item) => item.state)).toEqual([
    "accepted",
    "refused",
  ]);
  expect(results.items[1].reason).toBe("retry_duplicate_task");
  expect(
    (
      await database.pool.query(
        "SELECT id FROM agent_retry_intents WHERE project_id=$1",
        [source.projectId],
      )
    ).rows,
  ).toHaveLength(1);
});

it("pages a large failed backlog with scoped signed cursors and does not lose unknown-evidence rows", async () => {
  const source = await fixture();

  await database.pool.query(
    "INSERT INTO runs SELECT (jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid()::text))).* FROM runs r CROSS JOIN generate_series(1,52) WHERE r.id=$1",
    [source.runId],
  );
  const first = await getAgentRetryBatchOptions(database.db, source);

  expect(first).toMatchObject({ totalFailed: 53, hasMore: true });
  expect(first.items).toHaveLength(50);
  const second = await getAgentRetryBatchOptions(database.db, source, {
    cursor: first.nextCursor!,
  });

  expect(second).toMatchObject({
    totalFailed: 53,
    hasMore: false,
    nextCursor: null,
  });
  expect(second.items).toHaveLength(3);
  expect(
    new Set([...first.items, ...second.items].map((item) => item.runId)).size,
  ).toBe(53);
  const foreign = await fixture();

  await expect(
    getAgentRetryBatchOptions(database.db, foreign, {
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ code: "CONFIG" });
});
