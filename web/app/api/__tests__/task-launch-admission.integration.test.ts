import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/task-launch-intents/route";
import { GET as PREVIEW } from "@/app/api/runs/launch-options/route";
import { GET } from "@/app/api/task-launch-intents/[intentId]/route";
import { POST as CANCEL } from "@/app/api/task-launch-intents/[intentId]/cancel/route";
import { POST as REPLACE } from "@/app/api/task-launch-intents/[intentId]/replace/route";
import { tasks } from "@/lib/db/schema";
import { updateTask } from "@/lib/services/tasks";
import * as worktree from "@/lib/worktree";
import { mintAssignment } from "@/lib/execution-host/assignments";
import { seedWorkspace } from "@/test-support/execution-host-seed";
import { MaisterError } from "@/lib/errors";
import { taskLaunchSettingsToken } from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchFirstDispatch } from "@/lib/tasks/launch-first-dispatch";
import { takeSchedulerLock } from "@/lib/scheduler";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  seedTaskLaunchFixture,
  bindPendingTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let fixture: TaskLaunchFixture;
let fixtureHostId: string;
let sessionActive = true;
let sessionUserId: string | null = null;
let seq = 0;

// The real Next request lifecycle runs these callbacks in the browser lane.
// Direct handler tests exercise admission without starting autonomous workers.
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/supervisor-client", async (original) => ({
  ...(await original<typeof import("@/lib/supervisor-client")>()),
  checkSupervisorHealth: async () => ({ kind: "available" }),
  listSessions: async () => [],
}));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!sessionActive)
      throw new MaisterError("UNAUTHENTICATED", "Session is required");

    return { id: sessionUserId ?? fixture.userId, role: "admin" };
  },
  requireProjectAction: async () => ({ role: "owner" }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_launch_http",
  });
  root = await mkdtempReal("task-launch-http-");
  fixture = await seedTaskLaunchFixture(database, root);
  ({ hostId: fixtureHostId } = await fakeExecutionHosts(database.db));
  vi.stubEnv("MAISTER_WORKTREES_ROOT", path.join(root, "worktrees"));
  vi.stubEnv("MAISTER_RUNTIME_ROOT", path.join(root, "runtime"));
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function body() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++seq,
    title: "Launch via API",
    prompt: "Private execution input",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });

  return {
    taskId,
    expectedTaskRevision: 0,
    expectedSettingsToken: await taskLaunchSettingsToken(database.db, taskId),
  };
}
function request(
  payload: unknown,
  key = randomUUID(),
  origin = "http://localhost",
): Request {
  return new Request("http://localhost/api/task-launch-intents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      Origin: origin,
    },
    body: JSON.stringify(payload),
  });
}

it("LA10 preview supplies the displayed revision, automatic triage state and existing launch without executing", async () => {
  const input = await body();
  const url = `http://localhost/api/runs/launch-options?taskId=${input.taskId}`;
  const before = await PREVIEW(new NextRequest(url));

  expect(before.status).toBe(200);
  const preview = await before.json();

  expect(preview.task.revision).toBe(input.expectedTaskRevision);
  expect(preview.settingsToken).toBe(input.expectedSettingsToken);
  expect(preview.canManagePackages).toBe(true);
  expect(preview.canCutPackages).toBe(true);
  expect(preview.qualification).toMatchObject({
    required: true,
    freshness: "unassessed",
    blockedReason: "qualification_required",
  });
  expect(preview.activeLaunch).toBeNull();
  const accepted = await (await POST(request(input))).json();
  const after = await (await PREVIEW(new NextRequest(url))).json();

  expect(after.activeLaunch).toEqual(accepted);
  expect(JSON.stringify(after.activeLaunch)).not.toContain(
    "Private execution input",
  );
  const runs = await database.pool.query(
    "SELECT id FROM runs WHERE task_id=$1",
    [input.taskId],
  );

  expect(runs.rows).toEqual([]);
  const malformed = new URL(url);

  malformed.searchParams.set("packageVersions", "{");
  expect((await PREVIEW(new NextRequest(malformed))).status).toBe(422);
  malformed.searchParams.set("packageVersions", '{"package":"adopt"}');
  expect((await PREVIEW(new NextRequest(malformed))).status).toBe(422);
});

it("LA13 accepts a recoverable intent-only response, replays its key, and GET exposes no input or mutation", async () => {
  const input = await body();
  const key = randomUUID();
  const accepted = await POST(request(input, key));

  expect(accepted.status).toBe(202);
  const receipt = await accepted.json();

  expect(receipt).toMatchObject({
    runId: null,
    state: "queued",
    basis: "manual",
  });
  expect(accepted.headers.get("location")).toBe(
    `/api/task-launch-intents/${receipt.intentId}`,
  );
  expect(await (await POST(request(input, key))).json()).toEqual(receipt);
  const before = (
    await database.pool.query(
      "SELECT to_jsonb(i) AS value FROM task_launch_intents i WHERE id=$1",
      [receipt.intentId],
    )
  ).rows[0].value;
  const read = await GET(
    new Request(`http://localhost${accepted.headers.get("location")}`),
    { params: Promise.resolve({ intentId: receipt.intentId }) },
  );

  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(receipt);
  expect(JSON.stringify(receipt)).not.toContain("Private execution input");
  expect(JSON.stringify(receipt)).not.toContain("provider");
  expect(
    (
      await database.pool.query(
        "SELECT to_jsonb(i) AS value FROM task_launch_intents i WHERE id=$1",
        [receipt.intentId],
      )
    ).rows[0].value,
  ).toEqual(before);
  await database.pool.query(
    "UPDATE projects SET archived_at=clock_timestamp() WHERE id=$1",
    [fixture.projectId],
  );
  try {
    const archived = await GET(
      new Request(`http://localhost${accepted.headers.get("location")}`),
      {
        params: Promise.resolve({ intentId: receipt.intentId }),
      },
    );

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual(receipt);
  } finally {
    await database.pool.query(
      "UPDATE projects SET archived_at=NULL WHERE id=$1",
      [fixture.projectId],
    );
  }
});

it("LA06 reports the existing request and its basis without accepting a competing decision", async () => {
  const input = await body();
  const accepted = await (await POST(request(input))).json();
  const refused = await POST(request(input));

  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    code: "CONFLICT",
    details: {
      reason: "launch_already_reserved",
      existing: { intentId: accepted.intentId, runId: null, basis: "manual" },
    },
  });
  const intents = await database.pool.query(
    "SELECT id,basis->>'kind' AS basis FROM task_launch_intents WHERE task_id=$1",
    [input.taskId],
  );

  expect(intents.rows).toEqual([{ id: accepted.intentId, basis: "manual" }]);
});

it("LA07 authenticates before body parsing and refuses client admission authority fields", async () => {
  const input = await body();

  sessionActive = false;
  expect((await POST(request({ isHuman: true }))).status).toBe(401);
  sessionActive = true;
  const forged = await POST(
    request({
      ...input,
      actorUserId: fixture.userId,
      mode: "manual",
      skipQualification: true,
    }),
  );

  expect(forged.status).toBe(400);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA07 refuses cross-origin session authorization before accepting a launch", async () => {
  const input = await body();
  const response = await POST(
    request(input, randomUUID(), "https://untrusted.invalid"),
  );

  expect(response.status).toBe(403);
  const missingOrigin = request(input);

  missingOrigin.headers.delete("Origin");
  expect((await POST(missingOrigin)).status).toBe(403);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(0);
});

it("LA07 keeps an intent ID from becoming a readable cross-project capability", async () => {
  const input = await body();
  const accepted = await POST(request(input));
  const receipt = await accepted.json();
  const outsider = randomUUID();

  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'viewer','active',false)",
    [outsider, `${outsider}@test.local`],
  );
  sessionUserId = outsider;
  const response = await GET(
    new Request("http://localhost/api/task-launch-intents/private"),
    { params: Promise.resolve({ intentId: receipt.intentId }) },
  );

  const params = { params: Promise.resolve({ intentId: receipt.intentId }) };

  expect((await POST(request(input))).status).toBe(404);
  expect((await POST(request({ ...input, taskId: randomUUID() }))).status).toBe(
    404,
  );
  expect(
    (
      await CANCEL(
        request({ expectedStateVersion: receipt.stateVersion }),
        params,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await REPLACE(
        request({ ...input, expectedStateVersion: receipt.stateVersion }),
        params,
      )
    ).status,
  ).toBe(404);

  sessionUserId = null;
  expect(response.status).toBe(404);
  expect(JSON.stringify(await response.json())).not.toContain(
    receipt.settingsDigest,
  );
});

it("LA08/13 cancels accepted work exactly once, replays the cancellation key and releases its ordinary reservation", async () => {
  const input = await body();
  const accepted = await (await POST(request(input))).json();
  const key = randomUUID();
  const cancellation = { expectedStateVersion: accepted.stateVersion };
  const params = { params: Promise.resolve({ intentId: accepted.intentId }) };

  const stale = await CANCEL(
    request({ expectedStateVersion: accepted.stateVersion + 1 }),
    params,
  );

  expect(stale.status).toBe(409);
  vi.stubEnv("MAISTER_UPGRADE_MAINTENANCE", "1");
  let cancelled: Response;

  try {
    cancelled = await CANCEL(request(cancellation, key), params);
  } finally {
    vi.stubEnv("MAISTER_UPGRADE_MAINTENANCE", undefined);
  }

  expect(cancelled.status).toBe(200);
  const receipt = await cancelled.json();

  expect(receipt).toMatchObject({
    intentId: accepted.intentId,
    state: "cancelled",
    stateVersion: 2,
    runId: null,
  });
  expect(
    await (await CANCEL(request(cancellation, key), params)).json(),
  ).toEqual(receipt);
  await database.pool.query(
    "UPDATE users SET account_status='disabled' WHERE id=$1",
    [fixture.userId],
  );
  try {
    expect((await CANCEL(request(cancellation, key), params)).status).toBe(404);
  } finally {
    await database.pool.query(
      "UPDATE users SET account_status='active' WHERE id=$1",
      [fixture.userId],
    );
  }
  expect(
    (await CANCEL(request({ expectedStateVersion: 2 }, key), params)).status,
  ).toBe(409);
  const successor = await POST(request(input));

  expect(successor.status).toBe(202);
  const next = await successor.json();

  expect(next.intentId).not.toBe(accepted.intentId);
  expect(
    (
      await CANCEL(request({ expectedStateVersion: 1 }, key), {
        params: Promise.resolve({ intentId: next.intentId }),
      })
    ).status,
  ).toBe(409);
});

it("LA05/08/13 replaces held work atomically, rolls back a refused replacement and never transfers its old decision", async () => {
  const input = await body();
  const accepted = await (await POST(request(input))).json();

  await updateTask(
    input.taskId,
    fixture.projectId,
    {
      prompt: "A newly authorized task revision",
      expectedRevision: 0,
    },
    database.db,
  );
  const replacement = {
    ...input,
    expectedTaskRevision: 1,
    expectedSettingsToken: await taskLaunchSettingsToken(
      database.db,
      input.taskId,
    ),
    expectedStateVersion: 2,
  };
  const params = { params: Promise.resolve({ intentId: accepted.intentId }) };

  expect(
    (
      await REPLACE(
        request({ ...replacement, expectedTaskRevision: 0 }),
        params,
      )
    ).status,
  ).toBe(409);
  expect(
    (await (await GET(new Request("http://localhost/status"), params)).json())
      .state,
  ).toBe("held");
  const key = randomUUID();
  const response = await REPLACE(request(replacement, key), params);

  expect(response.status).toBe(202);
  const receipt = await response.json();

  expect(receipt).toMatchObject({
    state: "queued",
    taskRevision: 1,
    basis: "manual",
    supersedesIntentId: accepted.intentId,
  });
  expect(receipt.intentId).not.toBe(accepted.intentId);
  expect(
    (await (await GET(new Request("http://localhost/status"), params)).json())
      .state,
  ).toBe("cancelled");
  expect(
    await (await REPLACE(request(replacement, key), params)).json(),
  ).toEqual(receipt);
  expect(
    (
      await REPLACE(
        request({ ...replacement, expectedStateVersion: 3 }, key),
        params,
      )
    ).status,
  ).toBe(409);
});

it("LA08 cancels a bound Pending run through the terminal owner and refuses cancellation after commitment", async () => {
  for (const commitment of [false, true]) {
    const input = await body();
    const accepted = await (await POST(request(input))).json();
    const db: Db = database.db;
    let bound: { runId: string; stateVersion: number };

    if (commitment) {
      const prepared = await prepareTaskLaunchIntent(db, accepted.intentId);

      if (!prepared.runId)
        throw new Error("Expected a real prepared Pending run");
      bound = { runId: prepared.runId, stateVersion: prepared.stateVersion };
    } else {
      bound = await bindPendingTaskLaunchFixture(database, accepted.intentId);
      await db.transaction((tx) =>
        mintAssignment(tx, {
          runId: bound.runId,
          hostId: fixtureHostId,
          reason: "launch",
        }),
      );
      await seedWorkspace(database.db, {
        runId: bound.runId,
        projectId: fixture.projectId,
        worktreePath: path.join(root, `pending-${bound.runId}`),
        parentRepoPath: fixture.repo,
      });
    }
    let expectedStateVersion = bound.stateVersion;

    if (commitment) {
      expectedStateVersion += 1;
      const dispatch = await prepareTaskLaunchFirstDispatch(db, bound.runId);

      if (!dispatch) throw new Error("Expected an undispatched bound fixture");
      await db.transaction(async (tx) => {
        await takeSchedulerLock(tx);
        await dispatch.apply(tx);
      });
    }
    const response = await CANCEL(request({ expectedStateVersion }), {
      params: Promise.resolve({ intentId: accepted.intentId }),
    });

    expect(response.status).toBe(commitment ? 409 : 200);
    const result = await database.pool.query(
      "SELECT status FROM runs WHERE id=$1",
      [bound.runId],
    );

    expect(result.rows[0].status).toBe(commitment ? "Pending" : "Abandoned");
    const events = await database.pool.query(
      "SELECT payload FROM domain_events WHERE run_id=$1 AND kind='run.abandoned'",
      [bound.runId],
    );

    expect(events.rows).toHaveLength(commitment ? 0 : 1);
    const ownership = await database.pool.query(
      `SELECT assignment.state,workspace.scheduled_removal_at
      FROM execution_assignments assignment JOIN workspaces workspace ON workspace.run_id=assignment.run_id
      WHERE assignment.run_id=$1`,
      [bound.runId],
    );

    expect(ownership.rows[0].state).toBe(commitment ? "active" : "released");
    expect(ownership.rows[0].scheduled_removal_at === null).toBe(commitment);
  }
});

it("LA08 leaves cancellation available during slow replacement Git preflight and refuses the cancelled predecessor afterward", async () => {
  const input = await body();
  const accepted = await (await POST(request(input))).json();
  const params = { params: Promise.resolve({ intentId: accepted.intentId }) };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const listBranches = worktree.listBranches;
  const probe = vi
    .spyOn(worktree, "listBranches")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;

      return listBranches(...args);
    });
  const replacing = REPLACE(
    request({ ...input, expectedStateVersion: 1 }),
    params,
  );

  await entered.promise;
  const cancelling = CANCEL(request({ expectedStateVersion: 1 }), params);
  let responses: Response[];

  try {
    await expect
      .poll(async () => {
        const status = await database.pool.query(
          "SELECT state FROM task_launch_intents WHERE id=$1",
          [accepted.intentId],
        );

        return status.rows[0].state;
      })
      .toBe("cancelled");
  } finally {
    release.resolve();
    responses = await Promise.all([replacing, cancelling]);
    probe.mockRestore();
  }

  expect(responses[0].status).toBe(409);
  expect(responses[1].status).toBe(200);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
        [input.taskId],
      )
    ).rows[0].n,
  ).toBe(1);
});

it("LA14 unresolved runner refusal identifies the actionable Flow slot without accepting work or exposing task input", async () => {
  const input = await body();

  await database.pool.query(
    "UPDATE platform_acp_runners SET enabled=false WHERE id=$1",
    [fixture.runnerId],
  );
  try {
    const response = await POST(
      request({
        ...input,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          input.taskId,
        ),
      }),
    );
    const error = await response.json();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(error).toMatchObject({
      details: {
        reason: "flow_runner_unresolved",
        slotKey: expect.any(String),
        label: expect.any(String),
      },
    });
    expect(error.message).toMatch(/runner/i);
    expect(JSON.stringify(error)).not.toContain("Private execution input");
    expect(
      (
        await database.pool.query(
          "SELECT id FROM task_launch_intents WHERE task_id=$1",
          [input.taskId],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await database.pool.query("SELECT id FROM runs WHERE task_id=$1", [
          input.taskId,
        ])
      ).rows,
    ).toEqual([]);
  } finally {
    await database.pool.query(
      "UPDATE platform_acp_runners SET enabled=true WHERE id=$1",
      [fixture.runnerId],
    );
  }
});
