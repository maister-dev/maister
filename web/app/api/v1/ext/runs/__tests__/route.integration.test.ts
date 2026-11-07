import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  flows,
  flowRevisions,
  librarianOperations,
  librarianTurns,
  projectMembers,
  projects,
  taskLaunchIntents,
  taskRelations,
  tasks,
  users,
} from "@/lib/db/schema";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import {
  admitLibrarianOperation,
  settleLibrarianOperation,
} from "@/lib/librarian/operations";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { issueToken } from "@/lib/tokens/issue";
import { git } from "@/test-support/git-fixture";
import {
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  seedTaskLaunchFixture,
  bindPendingTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import { qualificationFixture } from "@/test-support/task-qualification";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let number = 0;
let POST: typeof import("@/app/api/v1/ext/runs/route").POST;
let OPTIONS: typeof import("@/app/api/v1/ext/task-launch-intents/options/route").GET;

// The real Next request lifecycle runs these callbacks in the browser lane.
// Direct handler tests exercise admission without starting autonomous workers.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "ext_runs_intent_compatibility",
  });
  root = await mkdtempReal("ext-runs-intents-");
  fixture = await seedTaskLaunchFixture(database, root);
  POST = (await import("@/app/api/v1/ext/runs/route")).POST;
  OPTIONS = (await import("@/app/api/v1/ext/task-launch-intents/options/route"))
    .GET;
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function task(): Promise<string> {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++number,
    title: "External compatibility launch",
    prompt: "Private compatibility task source",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });

  return taskId;
}

async function ready(taskId: string): Promise<void> {
  const [current] = await database.db
    .select({ inputRevision: tasks.qualificationInputRevision })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: current.inputRevision,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(prepared.apply);
  await database.db
    .update(tasks)
    .set({ launchIntent: "triage_then_launch", launchMode: "auto" })
    .where(eq(tasks.id, taskId));
}

async function input(taskId: string, secret: string) {
  const response = await OPTIONS(
    new Request(
      `http://localhost/api/v1/ext/task-launch-intents/options?${new URLSearchParams({ taskId })}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    ),
  );
  const options = z
    .object({
      taskId: z.string(),
      taskRevision: z.number(),
      settingsToken: z.string(),
    })
    .parse(await response.json());

  expect(response.status).toBe(200);

  return {
    taskId,
    expectedTaskRevision: options.taskRevision,
    expectedSettingsToken: options.settingsToken,
  };
}

function request(
  body: unknown,
  secret: string | null,
  key: string | null = randomUUID(),
): NextRequest {
  return new NextRequest("http://localhost/api/v1/ext/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function counts(
  taskId: string,
): Promise<{ intents: number; runs: number }> {
  const result = await database.pool.query<{ intents: number; runs: number }>(
    "SELECT (SELECT count(*)::int FROM task_launch_intents WHERE task_id=$1) AS intents,(SELECT count(*)::int FROM runs WHERE task_id=$1) AS runs",
    [taskId],
  );

  return result.rows[0];
}

it("LA07 legacy launch authenticates before validation and existence-hides foreign task state", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compatibility scope",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  expect((await POST(request({ mode: "manual" }, null), {})).status).toBe(401);
  expect((await POST(request({ taskId }, "mai_invalid"), {})).status).toBe(401);
  const otherProject = randomUUID();
  const foreignTask = randomUUID();

  await database.db.insert(projects).values({
    id: otherProject,
    slug: otherProject,
    name: "Foreign",
    repoPath: `${root}/foreign`,
    taskKey: "FOREIGN",
  });
  await database.db.insert(tasks).values({
    id: foreignTask,
    projectId: otherProject,
    number: 1,
    title: "Foreign",
    prompt: "Foreign task",
    status: "Done",
  });
  const missing = await POST(
    request({ taskId: randomUUID() }, token.secret),
    {},
  );
  const foreign = await POST(
    request({ taskId: foreignTask }, token.secret),
    {},
  );

  expect(missing.status).toBe(404);
  expect(foreign.status).toBe(404);
  expect(await foreign.json()).toEqual(await missing.json());
  expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
});

it("LA13 legacy new effects require displayed revision/settings and a key, and never admit forged manual authority", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compatibility upgrade",
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const unversioned = await POST(request({ taskId }, token.secret), {});

  expect(unversioned.status).toBe(422);
  expect(await unversioned.json()).toMatchObject({
    code: "CONFIG",
    details: { reason: "launch_request_upgrade_required" },
  });
  const body = await input(taskId, token.secret);

  expect((await POST(request(body, token.secret, null), {})).status).toBe(422);
  expect(
    (
      await POST(
        request(
          { ...body, mode: "manual", actorUserId: fixture.userId },
          token.secret,
        ),
        {},
      )
    ).status,
  ).toBe(422);
  expect(
    (await POST(request({ ...body, flowId: fixture.flowId }, token.secret), {}))
      .status,
  ).toBe(422);
  const unqualified = await POST(request(body, token.secret), {});

  expect(unqualified.status).toBe(409);
  expect(await unqualified.json()).toMatchObject({
    details: { reason: "qualification_required" },
  });
  expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
});

it("LA13 legacy versioned acceptance returns a truthful automatic intent and replays frozen input after task/triage drift", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compatibility accepted",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  await ready(taskId);
  const body = await input(taskId, token.secret);
  const key = randomUUID();
  const accepted = await POST(request(body, token.secret, key), {});
  const receipt = z
    .object({
      accepted: z.literal(true),
      code: z.literal("launch_pending"),
      intentId: z.string(),
      state: z.string(),
    })
    .parse(await accepted.json());

  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("location")).toBe(
    `/api/v1/ext/task-launch-intents/${receipt.intentId}`,
  );
  expect(await counts(taskId)).toEqual({ intents: 1, runs: 0 });
  await database.db
    .update(tasks)
    .set({
      prompt: "Changed after acceptance",
      revision: 1,
      launchMode: "manual",
    })
    .where(eq(tasks.id, taskId));
  const replay = await POST(request(body, token.secret, key), {});

  expect(replay.status).toBe(202);
  expect(await replay.json()).toMatchObject({
    intentId: receipt.intentId,
    accepted: true,
  });
  expect(
    (
      await POST(
        request({ ...body, expectedTaskRevision: 1 }, token.secret, key),
        {},
      )
    ).status,
  ).toBe(409);
  const [stored] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(stored.basis.kind).toBe("automatic");
  expect(JSON.stringify(stored.inputSnapshot)).toContain(
    "Private compatibility task source",
  );
  expect(JSON.stringify(stored.inputSnapshot)).not.toContain(
    "Changed after acceptance",
  );
  expect(await counts(taskId)).toEqual({ intents: 1, runs: 0 });
});

it("LA13 compatibility preserves runner aliases and real Git branch selections while rejecting conflicts", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compatibility alias",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  await git(fixture.repo, "branch", "develop");
  await git(fixture.repo, "branch", "release");
  await database.db
    .update(tasks)
    .set({ baseBranch: "develop", targetBranch: "release" })
    .where(eq(tasks.id, taskId));
  await ready(taskId);
  const body = await input(taskId, token.secret);
  const conflict = await POST(
    request(
      {
        ...body,
        runnerId: fixture.runnerId,
        executorOverrideId: "other-runner",
      },
      token.secret,
    ),
    {},
  );

  expect(conflict.status).toBe(422);
  const accepted = await POST(
    request(
      {
        ...body,
        executorOverrideId: fixture.runnerId,
        baseBranch: "develop",
        targetBranch: "release",
      },
      token.secret,
    ),
    {},
  );
  const receipt = await accepted.json();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(accepted.status).toBe(202);
  expect(intent.settingsSnapshot.sessions[0].runnerId).toBe(fixture.runnerId);
  expect(intent.settingsSnapshot).toMatchObject({
    baseBranch: "develop",
    targetBranch: "release",
    baseCommit: await git(fixture.repo, "rev-parse", "develop"),
  });
  expect(await counts(taskId)).toEqual({ intents: 1, runs: 0 });
});

it("IT-LOP-07 legacy Librarian receipts survive cutover without rewriting historical results or granting new launch authority", async () => {
  const taskId = await task();
  const turnId = await seedLibrarianTurn(database.db, fixture.userId);
  const [turn] = await database.db
    .select()
    .from(librarianTurns)
    .where(eq(librarianTurns.id, turnId));
  const token = await issueLibrarianTurnToken(
    {
      ownerUserId: fixture.userId,
      turnId,
      scopes: ["runs:launch"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );
  const key = randomUUID();
  const body = { taskId };
  const operation = await admitLibrarianOperation(
    {
      conversationId: turn.conversationId,
      segmentId: turn.segmentId,
      turnId,
      idempotencyKey: key,
      kind: "run_launch",
      target: { route: "/api/v1/ext/runs" },
      body,
      allowDuplicate: false,
    },
    database.db,
  );
  const historicalReceipt = {
    runId: randomUUID(),
    status: "Pending",
    queuePosition: 1,
  };

  await settleLibrarianOperation(
    { id: operation.id, result: { statusCode: 202, body: historicalReceipt } },
    database.db,
  );
  const before = await database.db
    .select()
    .from(librarianOperations)
    .where(eq(librarianOperations.id, operation.id));
  const replay = await POST(request(body, token.secret, key), {});

  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(historicalReceipt);
  expect(
    await database.db
      .select()
      .from(librarianOperations)
      .where(eq(librarianOperations.id, operation.id)),
  ).toEqual(before);
  const fresh = await POST(request(body, token.secret), {});

  expect(fresh.status).toBe(409);
  const anotherTask = await task();
  const newEffect = await POST(
    request({ taskId: anotherTask }, token.secret),
    {},
  );

  expect(newEffect.status).toBe(422);
  expect(await newEffect.json()).toMatchObject({
    details: { reason: "launch_request_upgrade_required" },
  });
  expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
  expect(await counts(anotherTask)).toEqual({ intents: 0, runs: 0 });
});

it("LA13 a real required-audit outage rolls back intent acceptance and same-key Librarian retry settles admitted work", async () => {
  const taskId = await task();
  const turnId = await seedLibrarianTurn(database.db, fixture.userId);
  const token = await issueLibrarianTurnToken(
    {
      ownerUserId: fixture.userId,
      turnId,
      scopes: ["runs:launch"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );

  await ready(taskId);
  const body = await input(taskId, token.secret);
  const key = randomUUID();

  await database.pool.query(
    `CREATE FUNCTION legacy_launch_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.token_id='${token.tokenId}' AND NEW.result='ok' THEN RAISE EXCEPTION 'fixture audit unavailable' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$`,
  );
  await database.pool.query(
    "CREATE TRIGGER legacy_launch_audit_fault BEFORE INSERT ON token_audit_log FOR EACH ROW EXECUTE FUNCTION legacy_launch_audit_fault()",
  );
  try {
    const unavailable = await POST(request(body, token.secret, key), {});

    expect(unavailable.status).toBe(503);
    expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
    expect(
      (
        await database.pool.query<{ status: string }>(
          "SELECT status FROM librarian_operations WHERE turn_id=$1",
          [turnId],
        )
      ).rows,
    ).toEqual([{ status: "admitted" }]);
  } finally {
    await database.pool.query(
      "DROP TRIGGER legacy_launch_audit_fault ON token_audit_log",
    );
    await database.pool.query("DROP FUNCTION legacy_launch_audit_fault()");
  }
  const recovered = await POST(request(body, token.secret, key), {});
  const recoveredBody = await recovered.json();

  expect(recovered.status).toBe(202);
  expect(recoveredBody).toMatchObject({
    accepted: true,
    code: "launch_pending",
  });
  expect(await counts(taskId)).toEqual({ intents: 1, runs: 0 });
  expect(
    (
      await database.pool.query<{ status: string; intent_id: string }>(
        "SELECT status,result->'body'->>'intentId' AS intent_id FROM librarian_operations WHERE turn_id=$1",
        [turnId],
      )
    ).rows,
  ).toEqual([{ status: "succeeded", intent_id: recoveredBody.intentId }]);
});

it("LA07 personal token owner attribution and live membership survive compatibility admission", async () => {
  const ownerId = await seedActiveUser(database.db);

  await database.db
    .update(users)
    .set({ mustChangePassword: false })
    .where(eq(users.id, ownerId));
  await database.db
    .insert(projectMembers)
    .values({ projectId: fixture.projectId, userId: ownerId, role: "owner" });
  const token = await issueToken(
    {
      projectId: null,
      name: "Global compatibility",
      tokenKind: "user",
      ownerUserId: ownerId,
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const taskId = await task();

  await ready(taskId);
  const body = await input(taskId, token.secret);
  const accepted = await POST(request(body, token.secret), {});
  const receipt = await accepted.json();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(accepted.status).toBe(202);
  expect(intent.actorUserId).toBe(ownerId);
  expect(intent.basis.kind).toBe("automatic");
  await database.db
    .delete(projectMembers)
    .where(eq(projectMembers.userId, ownerId));
  const hidden = await POST(request(body, token.secret), {});

  expect(hidden.status).toBe(404);
});

it("IT-EDGE-LOP-03 compatibility admission preserves unresolved dependency protections", async () => {
  const taskId = await task();
  const dependencyId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Compatibility dependency",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  await ready(taskId);
  await database.db.insert(taskRelations).values({
    id: randomUUID(),
    projectId: fixture.projectId,
    fromTaskId: taskId,
    toTaskId: dependencyId,
    kind: "requires",
    actorType: "user",
    actorId: fixture.userId,
  });
  const body = await input(taskId, token.secret);
  const response = await POST(request(body, token.secret), {});

  expect(response.status).toBe(409);
  expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
});

it("LA13 compatibility preserves the canonical legacy Flow refusal before accepting execution", async () => {
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));

  if (!flow?.enabledRevisionId)
    throw new Error("Launch fixture has no Flow revision");
  const [revision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flow.enabledRevisionId));
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const manifest = { schemaVersion: 1, name: "Legacy fixture", steps: [] };

  await database.db.insert(flowRevisions).values({
    ...revision,
    id: revisionId,
    flowRefId: flowId,
    manifest,
    manifestDigest: "b".repeat(64),
  });
  await database.db.insert(flows).values({
    ...flow,
    id: flowId,
    flowRefId: flowId,
    enabledRevisionId: revisionId,
    manifest,
  });
  const taskId = await task();

  await database.db.update(tasks).set({ flowId }).where(eq(tasks.id, taskId));
  await ready(taskId);
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Legacy Flow compatibility",
      scopes: ["runs:launch"],
    },
    database.db,
  );
  const body = await input(taskId, token.secret);
  const response = await POST(request(body, token.secret), {});

  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    code: "CONFIG",
    details: { reason: "flow_legacy_steps" },
  });
  expect(await counts(taskId)).toEqual({ intents: 0, runs: 0 });
});

it("LA13 compatibility returns a run id only after its accepted intent is actually bound", async () => {
  const taskId = await task();
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Bound compatibility",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  await ready(taskId);
  const body = await input(taskId, token.secret);
  const key = randomUUID();
  const accepted = await POST(request(body, token.secret, key), {});
  const pending = await accepted.json();

  expect(pending).toMatchObject({ accepted: true, code: "launch_pending" });
  expect(pending).not.toHaveProperty("runId");
  const bound = await bindPendingTaskLaunchFixture(database, pending.intentId);
  const replay = await POST(request(body, token.secret, key), {});

  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual({
    runId: bound.runId,
    status: "Pending",
    intentId: pending.intentId,
  });
  expect(await counts(taskId)).toEqual({ intents: 1, runs: 1 });
});
