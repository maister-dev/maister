import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/v1/ext/task-launch-intents/route";
import { GET } from "@/app/api/v1/ext/task-launch-intents/[intentId]/route";
import { tasks } from "@/lib/db/schema";
import { issueToken } from "@/lib/tokens/issue";
import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { prepareTaskQualification } from "@/lib/tasks/qualification";
import { taskLaunchSettingsToken } from "@/lib/tasks/launch-intent";
import * as worktree from "@/lib/worktree";
import {
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import { qualificationFixture } from "@/test-support/task-qualification";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_external",
  });
  root = await mkdtempReal("task-launch-external-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function input() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "External launch",
    prompt: "Private task source sentinel",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });

  return {
    taskId,
    expectedTaskRevision: 0,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
  };
}
async function ready(taskId: string): Promise<void> {
  const prepared = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
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
function request(
  body: unknown,
  secret: string | null,
  key: string = randomUUID(),
): Request {
  return new Request("http://localhost/api/v1/ext/task-launch-intents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
function read(intentId: string, secret: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/v1/ext/task-launch-intents/${intentId}`, {
      headers: { Authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ intentId }) },
  );
}

it("LA07 external auth precedes validation; bearer metadata cannot forge manual admission", async () => {
  expect((await POST(request({ mode: "manual" }, null))).status).toBe(401);
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Launch external",
      scopes: ["runs:launch", "runs:read"],
    },
    database.db,
  );
  const body = await input();
  const forged = await POST(
    request(
      { ...body, mode: "manual", actorUserId: fixture.userId },
      token.secret,
    ),
  );

  expect(forged.status).toBe(422);
  const missing = await POST(request(body, token.secret));

  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({
    details: { reason: "qualification_required" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [body.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await database.pool.query(
        "SELECT status_code FROM token_audit_log WHERE token_id=$1 ORDER BY created_at",
        [token.tokenId],
      )
    ).rows.map((row: { status_code: number }) => row.status_code),
  ).toEqual([422, 409]);
});

it("LA13 external acceptance returns an automatic intent, preserves replay audit and scopes metadata", async () => {
  const token = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Qualified launch",
      scopes: ["runs:launch", "runs:read"],
    },
    database.db,
  );
  const body = await input();

  await ready(body.taskId);
  const key = randomUUID();
  const response = await POST(request(body, token.secret, key));
  const receipt = await response.json();

  expect(response.status).toBe(202);
  expect(receipt).toMatchObject({
    basis: "automatic",
    runId: null,
    state: "queued",
  });
  expect(response.headers.get("location")).toBe(
    `/api/v1/ext/task-launch-intents/${receipt.intentId}`,
  );
  expect(await (await POST(request(body, token.secret, key))).json()).toEqual(
    receipt,
  );
  expect(await (await read(receipt.intentId, token.secret)).json()).toEqual(
    receipt,
  );
  expect(JSON.stringify(receipt)).not.toContain("Private task source sentinel");
  expect(JSON.stringify(receipt)).not.toContain(token.secret);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM token_audit_log WHERE token_id=$1 AND method='POST' AND result='ok'",
        [token.tokenId],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await POST(request({ ...body, autoPromote: true }, token.secret, key)))
      .status,
  ).toBe(409);

  const readOnly = await issueToken(
    { projectId: fixture.projectId, name: "Read only", scopes: ["runs:read"] },
    database.db,
  );

  expect((await read(receipt.intentId, readOnly.secret)).status).toBe(200);
  expect((await POST(request(body, readOnly.secret))).status).toBe(403);
  const launchOnly = await issueToken(
    {
      projectId: fixture.projectId,
      name: "Launch only",
      scopes: ["runs:launch"],
    },
    database.db,
  );

  expect((await read(receipt.intentId, launchOnly.secret)).status).toBe(403);
  const outsideUser = await seedActiveUser(database.db);
  const other = await issueToken(
    {
      projectId: null,
      tokenKind: "user",
      ownerUserId: outsideUser,
      name: "Outside project",
      scopes: ["runs:read"],
    },
    database.db,
  );

  expect((await read(receipt.intentId, other.secret)).status).toBe(404);
  expect((await read(randomUUID(), other.secret)).status).toBe(404);
  await database.pool.query(
    "UPDATE project_tokens SET revoked_at=clock_timestamp() WHERE id=$1",
    [token.tokenId],
  );
  expect((await POST(request(body, token.secret, key))).status).toBe(401);
});

it("LA13 Librarian acceptance settles the source-bound operation and audit atomically with the intent", async () => {
  const turnId = await seedLibrarianTurn(database.db, fixture.userId);
  const token = await issueLibrarianTurnToken(
    {
      ownerUserId: fixture.userId,
      turnId,
      scopes: ["runs:launch", "runs:read"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );
  const body = await input();

  await ready(body.taskId);
  const key = `librarian-launch-${randomUUID()}${"x".repeat(120)}`;
  const response = await POST(request(body, token.secret, key));
  const receipt = await response.json();

  expect(response.status).toBe(202);
  expect(receipt).toMatchObject({ basis: "automatic", runId: null });
  const replay = await POST(request(body, token.secret, key));

  expect(await replay.json()).toEqual(receipt);
  expect(replay.headers.get("location")).toBe(response.headers.get("location"));
  expect(replay.headers.get("cache-control")).toBe("no-store");
  const operations = await database.pool.query(
    "SELECT status,result FROM librarian_operations WHERE turn_id=$1",
    [turnId],
  );

  expect(operations.rows).toHaveLength(1);
  expect(operations.rows[0]).toMatchObject({
    status: "succeeded",
    result: { statusCode: 202, body: receipt },
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [body.taskId],
      )
    ).rows[0].n,
  ).toBe(1);
  const nextTurnId = await seedLibrarianTurn(database.db, fixture.userId);
  const nextToken = await issueLibrarianTurnToken(
    {
      ownerUserId: fixture.userId,
      turnId: nextTurnId,
      scopes: ["runs:launch"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );
  const nextTurnReplay = await POST(request(body, nextToken.secret, key));

  expect(nextTurnReplay.status).toBe(202);
  expect(await nextTurnReplay.json()).toEqual(receipt);
  expect(
    (
      await database.pool.query(
        "SELECT principal_id FROM task_launch_intents WHERE id=$1",
        [receipt.intentId],
      )
    ).rows[0].principal_id,
  ).toBe(token.tokenId);
  await database.pool.query(
    "UPDATE librarian_turns SET status='completed',ended_at=clock_timestamp() WHERE id=$1",
    [nextTurnId],
  );
  expect((await POST(request(body, token.secret, key))).status).toBe(401);
});

it("LA13 concurrent Librarian replay recovers an admitted operation into one truthful launch receipt", async () => {
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
  const body = await input();

  await ready(body.taskId);
  const key = randomUUID();
  let entered: () => void = () => {};
  let resume: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const original = worktree.listBranches;
  const probe = vi
    .spyOn(worktree, "listBranches")
    .mockImplementationOnce(async (...args) => {
      entered();
      await released;

      return original(...args);
    });
  const first = POST(request(body, token.secret, key));

  try {
    await Promise.race([
      paused,
      first.then(() => {
        throw new Error("First request ended before Git preflight");
      }),
    ]);
    const second = await POST(request(body, token.secret, key));
    const receipt = await second.json();

    expect(second.status).toBe(202);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      taskId: body.taskId,
      basis: "automatic",
      runId: null,
      state: "queued",
    });
    expect(second.headers.get("location")).toBe(
      `/api/v1/ext/task-launch-intents/${receipt.intentId}`,
    );
    resume();
    const originalResponse = await first;

    expect(originalResponse.status).toBe(202);
    expect(await originalResponse.json()).toEqual(receipt);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
          [body.taskId],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    resume();
    probe.mockRestore();
    await first;
  }
});

it("LA13 a real transient audit failure permits same-key Librarian recovery without accepting unaudited work", async () => {
  const turnId = await seedLibrarianTurn(database.db, fixture.userId);
  const token = await issueLibrarianTurnToken(
    {
      ownerUserId: fixture.userId,
      turnId,
      scopes: ["runs:launch", "runs:read"],
      expiresAt: new Date(Date.now() + 60_000),
    },
    database.db,
  );
  const body = await input();

  await ready(body.taskId);
  const key = randomUUID();
  const faultFunction = `CREATE FUNCTION launch_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.token_id='${token.tokenId}' AND NEW.result='ok' THEN RAISE EXCEPTION 'fixture audit outage' USING ERRCODE='40001'; END IF; RETURN NEW; END; $$`;
  const faultTrigger =
    "CREATE TRIGGER launch_audit_fault BEFORE INSERT ON token_audit_log FOR EACH ROW EXECUTE FUNCTION launch_audit_fault()";

  await database.pool.query(faultFunction);
  await database.pool.query(faultTrigger);
  try {
    expect((await POST(request(body, token.secret, key))).status).toBe(503);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
          [body.taskId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM librarian_operations WHERE turn_id=$1",
          [turnId],
        )
      ).rows[0].status,
    ).toBe("admitted");
  } finally {
    await database.pool.query(
      "DROP TRIGGER launch_audit_fault ON token_audit_log",
    );
    await database.pool.query("DROP FUNCTION launch_audit_fault()");
  }
  const recovered = await POST(request(body, token.secret, key));
  const receipt = await recovered.json();

  expect(recovered.status).toBe(202);
  expect(receipt).toMatchObject({
    schemaVersion: 1,
    basis: "automatic",
    taskId: body.taskId,
  });
  expect(
    (
      await database.pool.query(
        "SELECT status FROM librarian_operations WHERE turn_id=$1",
        [turnId],
      )
    ).rows[0].status,
  ).toBe("succeeded");
  await database.pool.query(faultFunction);
  await database.pool.query(faultTrigger);
  try {
    const unavailable = await read(receipt.intentId, token.secret);

    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      details: { reason: "launch_storage_unavailable" },
    });
  } finally {
    await database.pool.query(
      "DROP TRIGGER launch_audit_fault ON token_audit_log",
    );
    await database.pool.query("DROP FUNCTION launch_audit_fault()");
  }
  expect(await (await read(receipt.intentId, token.secret)).json()).toEqual(
    receipt,
  );
});
