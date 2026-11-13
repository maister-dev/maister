import type { InteractiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/runs/route";
import { PATCH as saveMapping } from "@/app/api/projects/[slug]/flow-runner-remaps/route";
import { POST as preview } from "@/app/api/runs/launch-options/route";
import { POST as ACCEPT } from "@/app/api/task-launch-intents/route";
import { POST as CONCURRENT } from "@/app/api/task-launch-intents/concurrent/route";
import { MaisterError } from "@/lib/errors";
import {
  tasks,
  runs,
  taskLaunchIntents,
  flows,
  flowRevisions,
  platformAcpRunners,
} from "@/lib/db/schema";
import {
  taskLaunchSettingsToken,
  acceptConcurrentInteractiveTaskLaunch,
} from "@/lib/tasks/launch-intent";
import {
  seedTaskLaunchFixture,
  bindPendingTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { git } from "@/test-support/git-fixture";
import { mkdtempReal } from "@/test-support/worktree-test-root";

let database: StartedPostgresTestDb;
let root: string;
let fixture: TaskLaunchFixture;
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
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => {
    if (!sessionActive)
      throw new MaisterError("UNAUTHENTICATED", "Session is required");

    return { id: sessionUserId ?? fixture.userId };
  },
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "legacy_intent_http",
  });
  root = await mkdtempReal("legacy-intent-http-");
  fixture = await seedTaskLaunchFixture(database, root);
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function body() {
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++seq,
    title: "Explicit legacy launch",
    prompt: "No qualification is required for this human launch",
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
  key: string | null = randomUUID(),
): NextRequest {
  return new NextRequest("http://localhost/api/runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...(key === null ? {} : { "Idempotency-Key": key }),
    },
    body: JSON.stringify(payload),
  });
}

it("L2 previews and freezes a one-run primary without saving it on the task", async () => {
  const input = await body();
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const [configured] = await database.db
    .select()
    .from(platformAcpRunners)
    .where(eq(platformAcpRunners.id, fixture.runnerId));
  const override = randomUUID();

  await database.db
    .insert(platformAcpRunners)
    .values({ ...configured, id: override });
  const flowRunnerDraft = {
    flowRevisionId: flow.enabledRevisionId,
    primaryRunnerId: override,
  };
  const selection = { taskId: input.taskId, flowRunnerDraft };

  const options = await preview(request(selection));

  expect(options.status).toBe(200);
  expect(options.headers.get("cache-control")).toBe("no-store");
  const previewBody = await options.json();

  expect(previewBody.selectedFlowRevisionId).toBe(flow.enabledRevisionId);
  expect(previewBody.options.selectedRunnerId).toBe(override);
  expect(await countIntents(input.taskId)).toBe(0);
  const payload = {
    ...input,
    flowRunnerDraft,
    expectedSettingsToken: previewBody.options.settingsToken,
  };

  expect((await POST(request(payload))).status).toBe(400);
  const accepted = await ACCEPT(request(payload));

  expect(accepted.status).toBe(202);
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.taskId, input.taskId));
  const [task] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));

  expect(intent.settingsSnapshot).toMatchObject({
    sessions: [{ runnerId: override }],
  });
  expect(task.runnerId).toBe(fixture.runnerId);

  const stale = await body();
  const beforeDrift = await preview(
    request({ taskId: stale.taskId, flowRunnerDraft }),
  );
  const stalePreview = await beforeDrift.json();

  expect(beforeDrift.status).toBe(200);
  await database.db
    .update(platformAcpRunners)
    .set({ model: "updated-model" })
    .where(eq(platformAcpRunners.id, override));
  const refused = await ACCEPT(
    request({
      ...stale,
      flowRunnerDraft,
      expectedSettingsToken: stalePreview.options.settingsToken,
    }),
  );

  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    details: { reason: "launch_settings_changed" },
  });
  expect(await countIntents(stale.taskId)).toBe(0);
});
it("L2 bounds interactive preview input and requires same-origin JSON", async () => {
  const input = await body();
  const send = (payload: string, origin = "http://localhost") =>
    preview(
      new NextRequest("http://localhost/api/runs/launch-options", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: payload,
      }),
    );

  expect(
    (
      await send(
        JSON.stringify({ taskId: input.taskId }),
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await send(
        JSON.stringify({ taskId: input.taskId, runnerId: fixture.runnerId }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await send(JSON.stringify({ taskId: input.taskId }) + " ".repeat(65_536)))
      .status,
  ).toBe(400);
  expect(await countIntents(input.taskId)).toBe(0);
});

it("L3 refuses a mapping save that loses the enabled revision lock", async () => {
  const [oldRevision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.flowRefId, fixture.flowId));
  const newRevisionId = randomUUID();

  await database.db.insert(flowRevisions).values({
    ...oldRevision,
    id: newRevisionId,
    resolvedRevision: "replacement",
    versionLabel: "v2",
  });

  const writer = await database.pool.connect();
  let response: Promise<Response> | undefined;

  try {
    await writer.query("BEGIN");
    const {
      rows: [writerSession],
    } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");

    await writer.query("UPDATE flows SET enabled_revision_id=$1 WHERE id=$2", [
      newRevisionId,
      fixture.flowId,
    ]);
    response = saveMapping(
      new NextRequest(
        "http://localhost/api/projects/fixture/flow-runner-remaps",
        {
          method: "PATCH",
          body: JSON.stringify({
            flowRevisionId: oldRevision.id,
            slotKey: "session:default",
            mappedRunnerId: fixture.runnerId,
          }),
        },
      ),
      { params: Promise.resolve({ slug: fixture.projectId }) },
    );

    await vi.waitFor(
      async () => {
        const {
          rows: [locks],
        } = await database.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%for update%'",
          [writerSession.pid],
        );

        expect(locks.n).toBe(1);
      },
      { timeout: 5000 },
    );
    await writer.query("COMMIT");

    expect((await response).status).toBe(409);
    const mappings = await database.pool.query(
      "SELECT id FROM flow_runner_remaps WHERE project_id=$1 AND flow_revision_id=$2",
      [fixture.projectId, oldRevision.id],
    );

    expect(mappings.rows).toEqual([]);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    await response;
    await database.db
      .update(flows)
      .set({ enabledRevisionId: oldRevision.id })
      .where(eq(flows.id, fixture.flowId));
  }
});

async function countIntents(taskId: string): Promise<number> {
  return (
    await database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM task_launch_intents WHERE task_id=$1",
      [taskId],
    )
  ).rows[0].n;
}

it("LA07/13 refuses unversioned legacy launches with actionable upgrade instructions before effects", async () => {
  const input = await body();

  for (const req of [request({ taskId: input.taskId }), request(input, null)]) {
    const response = await POST(req);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "CONFIG",
      details: {
        reason: "launch_request_upgrade_required",
        optionsEndpoint: `/api/runs/launch-options?taskId=${input.taskId}`,
        intentEndpoint: "/api/task-launch-intents",
      },
    });
  }
  expect(await countIntents(input.taskId)).toBe(0);
  expect(
    (
      await database.pool.query("SELECT id FROM runs WHERE task_id=$1", [
        input.taskId,
      ])
    ).rows,
  ).toEqual([]);
});

it("LA01/03/13 accepts one versioned manual decision without assessment and replays unchanged input after task edits", async () => {
  const input = await body();
  const key = randomUUID();
  const req = request(input, key);

  req.headers.set("Accept", "text/event-stream");
  const response = await POST(req);

  expect(response.status).toBe(202);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const pending = await response.json();

  expect(pending).toEqual({
    accepted: true,
    code: "launch_pending",
    intentId: expect.any(String),
    location: `/api/task-launch-intents/${pending.intentId}`,
  });
  expect(response.headers.get("location")).toBe(pending.location);
  await database.pool.query(
    "UPDATE tasks SET prompt='Changed after explicit launch' WHERE id=$1",
    [input.taskId],
  );
  expect(await (await POST(request(input, key))).json()).toEqual(pending);
  expect(await countIntents(input.taskId)).toBe(1);
  const stored = await database.pool.query(
    "SELECT basis,task_revision,input_snapshot FROM task_launch_intents WHERE id=$1",
    [pending.intentId],
  );

  expect(stored.rows[0]).toMatchObject({
    basis: { kind: "manual", userId: fixture.userId },
    task_revision: 0,
  });
  expect(JSON.stringify(stored.rows[0].input_snapshot)).toContain(
    "No qualification is required",
  );
  expect(JSON.stringify(stored.rows[0].input_snapshot)).not.toContain(
    "Changed after",
  );
});

it("LA07 authenticates first and rejects forged admission and a cross-origin Referer", async () => {
  sessionActive = false;
  expect((await POST(request({ mode: "manual" }))).status).toBe(401);
  sessionActive = true;
  const input = await body();

  expect(
    (await POST(request({ ...input, mode: "manual", skipQualification: true })))
      .status,
  ).toBe(400);
  const referrer = request(input);

  referrer.headers.delete("origin");
  referrer.headers.set("referer", "http://localhost/task");
  expect((await POST(referrer)).status).toBe(403);
  const crossOrigin = request(input);

  crossOrigin.headers.set("origin", "https://untrusted.invalid");
  crossOrigin.headers.set("referer", "http://localhost/task");
  expect((await POST(crossOrigin)).status).toBe(403);
  expect(await countIntents(input.taskId)).toBe(0);
});

it("LA07 checks live project access again before replaying a previously accepted legacy receipt", async () => {
  const input = await body();
  const key = randomUUID();

  expect((await POST(request(input, key))).status).toBe(202);
  sessionUserId = randomUUID();
  await database.pool.query(
    "INSERT INTO users(id,email,role,account_status,must_change_password) VALUES($1,$2,'viewer','active',false)",
    [sessionUserId, `${sessionUserId}@test.local`],
  );
  try {
    expect((await POST(request(input, key))).status).toBe(404);
  } finally {
    sessionUserId = null;
  }
  expect(await countIntents(input.taskId)).toBe(1);
});

it("LA13 returns typed setup-required for project package mutation", async () => {
  const input = await body();

  for (const extra of [
    { packageVersions: { package: "adopt" } },
    { packageVersions: { package: "cut_and_adopt" } },
  ]) {
    const response = await POST(request({ ...input, ...extra }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "CONFIG",
      details: { reason: "launch_request_setup_required" },
    });
  }
  expect(await countIntents(input.taskId)).toBe(0);
});

it("LA08/13 accepts scoped relaunch lineage with a fresh manual decision and current task input", async () => {
  const input = await body();
  const original = await (await POST(request(input))).json();
  const source = await bindPendingTaskLaunchFixture(
    database,
    original.intentId,
  );

  await database.db
    .update(runs)
    .set({ status: "Failed" })
    .where(eq(runs.id, source.runId));
  await database.db
    .update(tasks)
    .set({ prompt: "Fresh successor request" })
    .where(eq(tasks.id, input.taskId));
  const [task] = await database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.taskId));
  const selected = { relaunchOfRunId: source.runId };
  const response = await POST(
    request({
      taskId: input.taskId,
      expectedTaskRevision: task.revision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        task.id,
        selected,
      ),
      ...selected,
    }),
  );

  expect(response.status).toBe(202);
  const result = await response.json();
  const [successor] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, result.intentId));

  expect(successor.basis.kind).toBe("manual");
  expect(successor.sourceRunId).toBe(source.runId);
  expect(successor.inputSnapshot.prompt).toBe("Fresh successor request");
  expect(successor.settingsSnapshot).toMatchObject({
    relaunchSource: { runId: source.runId },
  });
});

it("LA13 returns the historical success schema only when the accepted intent has a real run binding", async () => {
  const input = await body();
  const key = randomUUID();
  const pending = await (await POST(request(input, key))).json();
  const bound = await bindPendingTaskLaunchFixture(database, pending.intentId);
  const response = await POST(request(input, key));

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    runId: bound.runId,
    status: "Pending",
  });
  expect(response.headers.get("location")).toBe(
    `/api/task-launch-intents/${pending.intentId}`,
  );
});

it("LA07 refuses a structurally forged human principal at the dedicated concurrent constructor", async () => {
  const input = await body();
  const principal = {
    kind: "session_user",
    userId: fixture.userId,
  } as unknown as InteractiveTaskLaunchPrincipal;

  await expect(
    acceptConcurrentInteractiveTaskLaunch(
      database.db,
      principal,
      input,
      randomUUID(),
    ),
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "launch_manual_authority_required" },
  });
  expect(await countIntents(input.taskId)).toBe(0);
});

it("LA08 separately authorizes and replays concurrent decisions without consuming the ordinary reservation", async () => {
  const input = await body();
  const ordinaryKey = randomUUID();
  const ordinary = await (await POST(request(input, ordinaryKey))).json();

  expect((await CONCURRENT(request(input, ordinaryKey))).status).toBe(409);
  expect(await (await POST(request(input, ordinaryKey))).json()).toEqual(
    ordinary,
  );
  const key = randomUUID();
  const response = await CONCURRENT(request(input, key));

  expect(response.status).toBe(202);
  const concurrent = await response.json();

  expect(concurrent).toMatchObject({ basis: "manual", runId: null });
  expect(concurrent.intentId).not.toBe(ordinary.intentId);
  expect(await (await CONCURRENT(request(input, key))).json()).toEqual(
    concurrent,
  );
  const rows = await database.pool.query<{ reservation_lane: string }>(
    "SELECT reservation_lane FROM task_launch_intents WHERE task_id=$1 ORDER BY reservation_lane",
    [input.taskId],
  );

  expect(rows.rows.map((row) => row.reservation_lane)).toEqual([
    "concurrent",
    "ordinary",
  ]);
  expect((await POST(request(input))).status).toBe(409);
  const legacyConcurrent = await POST(
    request({ ...input, allowConcurrent: true }),
  );

  expect(legacyConcurrent.status).toBe(202);
  expect((await legacyConcurrent.json()).code).toBe("launch_pending");
});

it("LA08 concurrent authorization keeps task holds and strict source boundaries", async () => {
  const input = await body();

  await database.pool.query(
    "UPDATE tasks SET triage_status='flagged',triage_flag_origin='explicit' WHERE id=$1",
    [input.taskId],
  );
  input.expectedSettingsToken = await taskLaunchSettingsToken(
    database.db,
    input.taskId,
  );
  expect((await CONCURRENT(request(input))).status).toBe(409);
  expect(
    (await CONCURRENT(request({ ...input, allowConcurrent: true }))).status,
  ).toBe(400);
  const crossOrigin = request(input);

  crossOrigin.headers.set("origin", "https://untrusted.invalid");
  expect((await CONCURRENT(crossOrigin)).status).toBe(403);
  expect(await countIntents(input.taskId)).toBe(0);
});

it("LA03/13 freezes selected Flow, branches, reachable commit and delivery settings through the compatibility route", async () => {
  const input = await body();
  const [installed] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const [revision] = await database.db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, installed.enabledRevisionId!));
  const selectedFlowId = randomUUID();
  const selectedRevisionId = randomUUID();
  const selectedRef = randomUUID();

  await database.db
    .insert(flowRevisions)
    .values({ ...revision, id: selectedRevisionId, flowRefId: selectedRef });
  await database.db.insert(flows).values({
    ...installed,
    id: selectedFlowId,
    flowRefId: selectedRef,
    enabledRevisionId: selectedRevisionId,
  });
  const baseBranch = `manual-base-${randomUUID()}`;
  const targetBranch = `manual-target-${randomUUID()}`;

  await git(fixture.repo, "branch", baseBranch);
  await git(fixture.repo, "branch", targetBranch);
  const baseCommit = await git(
    fixture.repo,
    "rev-parse",
    `${baseBranch}^{commit}`,
  );
  const deliveryPolicy = {
    strategy: "ai_rebase_merge" as const,
    push: "on_success" as const,
    trigger: "auto_on_ready" as const,
    targetBranch,
  };
  const response = await POST(
    request({
      ...input,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        input.taskId,
        { flowId: selectedFlowId },
      ),
      flowId: selectedFlowId,
      baseBranch,
      baseCommit,
      targetBranch,
      deliveryPolicy,
    }),
  );

  expect(response.status).toBe(202);
  const receipt = await response.json();
  const [stored] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(stored).toMatchObject({
    reservationLane: "ordinary",
    basis: { kind: "manual" },
    settingsSnapshot: {
      flowId: selectedFlowId,
      flowRevisionId: selectedRevisionId,
      baseBranch,
      baseCommit,
      targetBranch,
      deliveryPolicy,
    },
  });
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, input.taskId)),
  ).toEqual([]);
});

it("LA07/13 rejects invalid selection values before effects and distinguishes unavailable try_once from an invalid option", async () => {
  const input = await body();

  for (const extra of [
    { baseBranch: "" },
    { baseCommit: "not-a-sha" },
    { relaunchOfRunId: "" },
    { allowConcurrent: "yes" },
    { packageVersions: { missing: "adopt_forever" } },
  ]) {
    const response = await POST(request({ ...input, ...extra }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "CONFIG",
      details: { reason: "launch_request_invalid" },
    });
  }
  const unavailable = await POST(
    request({ ...input, packageVersions: { missing: "try_once" } }),
  );

  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toMatchObject({
    details: { reason: "launch_package_changed" },
  });
  expect(await countIntents(input.taskId)).toBe(0);
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, input.taskId)),
  ).toEqual([]);
});
