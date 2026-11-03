import type { ProjectAction } from "@/lib/authz";
import type { FakeExecutionHost } from "@/test-support/fake-execution-host";

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  tasks,
  taskLaunchIntents,
  runs,
  runSessions,
  platformAcpRunners,
  projects,
  flowRevisions,
  agentPreparationOperations,
  hitlRequests,
  workspaces,
} from "@/lib/db/schema";
import { previewBudgetRestart } from "@/lib/tasks/launch-budget-restart";
import { respondToHitl } from "@/lib/services/hitl";
import { createExecutionHosts } from "@/lib/execution-host";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  acceptAutomaticTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { frozenTaskAgentDefinition } from "@/lib/tasks/launch-agent-definition";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { createAgentFlowTaskLaunchSource } from "@/lib/agents/flow-launch-authority";
import { serverTaskLaunchRequest } from "@/lib/tasks/launch-intent";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";

let database: StartedPostgresTestDb;
let root: string;
let fixture: Awaited<ReturnType<typeof seedTaskLaunchFixture>>;
let previousRoot: string | undefined;
let previousRuntimeRoot: string | undefined;
let fake: FakeExecutionHost;

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
  requireProjectAction: async (projectId: string, action: ProjectAction) => {
    await assertTaskLaunchUserAuthority(
      database.db,
      projectId,
      fixture.userId,
      [action],
    );

    return { role: "admin" };
  },
}));
vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
vi.mock("@/lib/tasks/launch-wake", () => ({
  wakeAcceptedTaskLaunch: vi.fn(),
  wakeTaskLaunchQueue: vi.fn(),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "task_agent_admission",
  });
  root = await mkdtempReal("task-agent-admission-");
  previousRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
  process.env.MAISTER_RUNTIME_ROOT = root;
  fixture = await seedTaskLaunchFixture(database, root);
  await database.db
    .update(platformAcpRunners)
    .set({
      adapter: "claude",
      capabilityAgent: "claude",
      model: "claude-sonnet-4-6",
      provider: { kind: "anthropic" },
    })
    .where(eq(platformAcpRunners.id, fixture.runnerId));
  ({ fake } = await fakeExecutionHosts(database.db));
  const installed = path.join(root, "package");

  await mkdir(path.join(installed, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installed, "maister-agents", "delivery.md"),
    "---\nname: Delivery\ndescription: task delivery\nkind: code_delivery\nworkspace: worktree\nmode: session\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nExecute the exact task request.\n",
  );
  const installId = randomUUID();

  await database.db
    .update(flowRevisions)
    .set({ resolvedRevision: "agent-revision" });

  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'local','launch-agents','v1','agent-revision','{}','digest',$2,'Installed','trusted')",
    [installId, installed],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,'launch-agents')",
    [randomUUID(), fixture.projectId, installId],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled) VALUES('launch-agents:delivery','launch-agents','v1','authored','Delivery','task delivery','worktree','session','[\"manual\"]','read_only',$1,true)",
    [path.join(installed, "maister-agents", "delivery.md")],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,agent_id,project_id) VALUES($1,'launch-agents:delivery',$2)",
    [randomUUID(), fixture.projectId],
  );
  await writeFile(
    path.join(installed, "maister-agents", "facade.md"),
    `---\nname: Facade\ndescription: drives the real Flow\nkind: code_delivery\nworkspace: worktree\nmode: session\ntriggers: [manual]\nrisk_tier: read_only\nflow: ${fixture.flowId}\n---\nFollow the exact task.\n`,
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled) VALUES('launch-agents:facade','launch-agents','v1','authored','Facade','drives the real Flow','worktree','session','[\"manual\"]','read_only',$1,true)",
    [path.join(installed, "maister-agents", "facade.md")],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,agent_id,project_id,execution_policy_override) VALUES($1,'launch-agents:facade',$2,'{\"autoApply\":\"permissions\"}')",
    [randomUUID(), fixture.projectId],
  );
  await writeFile(
    path.join(installed, "maister-agents", "events.md"),
    "---\nname: Event delivery\ndescription: task delivery from a real event\nkind: code_delivery\nworkspace: none\nmode: session\ntriggers: [domain_event]\nrisk_tier: read_only\nplatform_mcp: false\n---\nExecute the exact event request.\n",
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled) VALUES('launch-agents:events','launch-agents','v1','authored','Event delivery','task delivery','none','session','[\"domain_event\"]','read_only',$1,true)",
    [path.join(installed, "maister-agents", "events.md")],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,agent_id,project_id) VALUES($1,'launch-agents:events',$2)",
    [randomUUID(), fixture.projectId],
  );
  await writeFile(
    path.join(installed, "maister-agents", "cron.md"),
    "---\nname: Cron delivery\ndescription: durable scheduled delivery\nkind: code_delivery\nworkspace: none\nmode: session\ntriggers: [cron]\nrisk_tier: read_only\nplatform_mcp: false\n---\nExecute the exact scheduled request.\n",
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled) VALUES('launch-agents:cron','launch-agents','v1','authored','Cron delivery','scheduled delivery','none','session','[\"cron\"]','read_only',$1,true)",
    [path.join(installed, "maister-agents", "cron.md")],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,agent_id,project_id) VALUES($1,'launch-agents:cron',$2)",
    [randomUUID(), fixture.projectId],
  );
}, 180_000);

afterEach(async () => {
  const undispatched = await database.db
    .select({
      id: taskLaunchIntents.id,
      stateVersion: taskLaunchIntents.stateVersion,
    })
    .from(taskLaunchIntents)
    .leftJoin(runs, eq(runs.id, taskLaunchIntents.runId))
    .where(
      and(
        eq(taskLaunchIntents.projectId, fixture.projectId),
        inArray(taskLaunchIntents.state, ["queued", "held", "run_bound"]),
        isNull(taskLaunchIntents.dispatchCommittedAt),
        or(isNull(taskLaunchIntents.runId), eq(runs.status, "Pending")),
      ),
    );
  const principal = await interactiveTaskLaunchPrincipal();

  // Queue-only assertions must not leave candidates for a later test's slot release.
  for (const intent of undispatched)
    await cancelInteractiveTaskLaunch(
      database.db,
      principal,
      intent.id,
      { expectedStateVersion: intent.stateVersion },
      randomUUID(),
    );
});

afterAll(async () => {
  if (previousRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it.each(["none", "repo_read", "worktree"] as const)(
  "prepares actual %s workspace and commits its assignment proof before session creation",
  async (workspace) => {
    const body = await request(workspace);
    const receipt = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      body,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, receipt.intentId);

    expect(bound.runId).toBeTruthy();
    const { tryStartRun } = await import("@/lib/scheduler");
    const { startAgentSession } = await import("@/lib/agents/launch");
    const started = await tryStartRun(bound.runId!, { db: database.db });

    expect(started.started).toBe(true);
    let witnessed = false;
    const stop = fake.onCall("createSession", async () => {
      const [intent] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, receipt.intentId));

      expect(intent.dispatchCommittedAt).not.toBeNull();
      expect(intent.dispatchReceipt).toMatchObject({
        runId: bound.runId,
        inputDigest: intent.inputDigest,
        settingsDigest: intent.settingsDigest,
      });
      witnessed = true;
    });

    if (workspace === "none")
      await database.db
        .update(projects)
        .set({ repoPath: path.join(root, "unavailable-repository") })
        .where(eq(projects.id, fixture.projectId));
    try {
      await startAgentSession(bound.runId!, { db: database.db });
    } finally {
      stop();
      if (workspace === "none")
        await database.db
          .update(projects)
          .set({ repoPath: fixture.repo })
          .where(eq(projects.id, fixture.projectId));
    }
    expect(witnessed).toBe(true);
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId!));

    expect(run.operationalIntegrityBaseline?.resourceKind).toBe(
      workspace === "none"
        ? "plain_directory"
        : workspace === "repo_read"
          ? "shared_repository"
          : "worktree",
    );
    expect(run.operationalIntegrityBaseline?.generation).toBeGreaterThan(0);
  },
);

it("retains a real pre-model filesystem probe failure and creates no session", async () => {
  const body = await request("none");
  const receipt = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    body,
    randomUUID(),
  );
  const bound = await prepareTaskLaunchIntent(database.db, receipt.intentId);
  const { tryStartRun } = await import("@/lib/scheduler");
  const { startAgentSession } = await import("@/lib/agents/launch");
  const protectedPath = path.join(
    agentWorkdirPath(fixture.projectId, bound.runId!),
    "unreadable",
  );

  await mkdir(protectedPath, { recursive: true });
  await writeFile(
    path.join(protectedPath, "source.txt"),
    "Fixture content stays private",
  );
  await chmod(protectedPath, 0);
  expect((await tryStartRun(bound.runId!, { db: database.db })).started).toBe(
    true,
  );
  const before = fake.callsOf("createSession").length;

  try {
    await startAgentSession(bound.runId!, { db: database.db });
  } finally {
    await chmod(protectedPath, 0o700);
  }
  const [operation] = await database.db
    .select()
    .from(agentPreparationOperations)
    .where(eq(agentPreparationOperations.runId, bound.runId!));
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(fake.callsOf("createSession")).toHaveLength(before);
  expect(intent.dispatchCommittedAt).toBeNull();
  expect(operation.failure).toMatchObject({ stage: "baseline" });
  expect(JSON.stringify(operation.failure)).toContain("EACCES");
  expect(JSON.stringify(operation.failure)).not.toContain(
    "Fixture content stays private",
  );
});

it("uses an opaque session decision at the existing standalone agent endpoint and refuses stale or forged boundary metadata", async () => {
  const body = await request("none");
  const { POST } =
    await import("@/app/api/projects/[slug]/agents/[agentId]/launch/route");
  const url = `http://localhost/api/projects/${fixture.projectId}/agents/launch-agents:delivery/launch`;
  const payload = {
    taskId: body.taskId,
    runnerId: body.runnerId,
    workspace: body.workspace,
    expectedTaskRevision: body.expectedTaskRevision,
    expectedSettingsToken: body.expectedSettingsToken,
  };
  const params = {
    params: Promise.resolve({
      slug: fixture.projectId,
      agentId: "launch-agents:delivery",
    }),
  };
  const accepted = await POST(
    new NextRequest(url, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(payload),
    }),
    params,
  );

  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({
    basis: "manual",
    taskId: body.taskId,
    snapshot: { kind: "agent", workspace: "none", baseCommit: null },
  });
  const crossOrigin = await POST(
    new NextRequest(url, {
      method: "POST",
      headers: {
        origin: "http://attacker.invalid",
        "content-type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(payload),
    }),
    params,
  );

  expect(crossOrigin.status).toBe(403);
  const oldRequest = await POST(
    new NextRequest(url, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ taskId: body.taskId }),
    }),
    params,
  );

  expect(oldRequest.status).toBe(400);
  expect(await oldRequest.json()).toMatchObject({
    details: { reason: "launch_request_upgrade_required" },
  });
});

it("records a task-bound Flow-driving agent as a manual source-backed Flow intent without qualification", async () => {
  const body = await request("worktree");
  const source = await createAgentFlowTaskLaunchSource(database.db, {
    agentId: "launch-agents:facade",
    projectId: fixture.projectId,
    taskId: body.taskId,
    trigger: { source: "manual" },
  });
  const preview = await serverTaskLaunchRequest(database.db, source, {
    taskId: body.taskId,
    flowId: fixture.flowId,
  });
  const { POST } =
    await import("@/app/api/projects/[slug]/agents/[agentId]/launch/route");
  const response = await POST(
    new NextRequest(
      `http://localhost/api/projects/${fixture.projectId}/agents/launch-agents:facade/launch`,
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          taskId: body.taskId,
          expectedTaskRevision: preview.expectedTaskRevision,
          expectedSettingsToken: preview.expectedSettingsToken,
        }),
      },
    ),
    {
      params: Promise.resolve({
        slug: fixture.projectId,
        agentId: "launch-agents:facade",
      }),
    },
  );

  expect(response.status).toBe(202);
  const receipt = await response.json();
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, receipt.intentId));

  expect(intent.basis).toMatchObject({
    kind: "manual",
    userId: fixture.userId,
  });
  expect(intent.settingsSnapshot).toMatchObject({
    kind: "flow",
    flowId: fixture.flowId,
    serverExecution: {
      kind: "agent_trigger",
      execution: {
        agentId: "launch-agents:facade",
        agentPolicyOverlay: { autoApply: "permissions" },
      },
    },
  });
});

async function request(workspace: "none" | "repo_read" | "worktree") {
  const taskId = randomUUID();
  const [allocation] = await database.db
    .select({
      number: sql<number>`coalesce(max(${tasks.number}), 0) + 1`.mapWith(
        Number,
      ),
    })
    .from(tasks)
    .where(eq(tasks.projectId, fixture.projectId));

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: allocation.number,
    title: "Agent request",
    prompt: "Implement this exact task",
    qualificationMode: "required",
    flowId: null,
  });
  const selection = {
    taskId,
    agentId: "launch-agents:delivery",
    workspace,
    runnerId: fixture.runnerId,
  };

  return {
    ...selection,
    expectedTaskRevision: 0,
    expectedSettingsToken: await taskLaunchSettingsToken(
      database.db,
      taskId,
      selection,
    ),
  };
}

it.each(["none", "repo_read", "worktree"] as const)(
  "accepts a manual %s agent target without qualification and binds one real agent run",
  async (workspace) => {
    const body = await request(workspace);
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      body,
      randomUUID(),
    );

    expect(accepted.basis).toBe("manual");
    expect(accepted.snapshot).toMatchObject({
      kind: "agent",
      workspace,
      flowId: null,
      agentId: body.agentId,
    });
    if (workspace === "none") expect(accepted.snapshot.baseCommit).toBeNull();
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    expect(bound.state).toBe("run_bound");
    expect(bound.runId).toBeTruthy();
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId!));

    expect(run).toMatchObject({
      runKind: "agent",
      agentKind: "code_delivery",
      flowId: null,
      taskLaunchIntentId: accepted.intentId,
      agentWorkspace: workspace,
      status: "Pending",
      taskAdmissionSnapshot: { version: 2, basis: "manual" },
    });
    const sessions = await database.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, run.id));

    expect(sessions).toHaveLength(1);
    expect(sessions[0].runnerId).toBe(fixture.runnerId);
    expect(
      (await frozenTaskAgentDefinition(database.db, run))?.parsed.prompt,
    ).toContain("Execute the exact task request");
    expect(
      (await prepareTaskLaunchIntent(database.db, accepted.intentId)).runId,
    ).toBe(run.id);
  },
);

it("admits none without a repository or synthetic SHA, while automatic launch still needs qualification", async () => {
  await database.db
    .update(projects)
    .set({ repoPath: path.join(root, "not-a-repository") })
    .where(eq(projects.id, fixture.projectId));
  try {
    const body = await request("none");
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      body,
      randomUUID(),
    );

    expect(accepted.snapshot.baseCommit).toBeNull();
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));

    expect(intent.settingsSnapshot.baseCommit).toBeNull();
  } finally {
    await database.db
      .update(projects)
      .set({ repoPath: fixture.repo })
      .where(eq(projects.id, fixture.projectId));
  }
  const other = await request("none");

  await expect(
    acceptAutomaticTaskLaunch(database.db, other, randomUUID()),
  ).rejects.toMatchObject({ details: { reason: "qualification_required" } });
});

it("restarts a real NONE agent through a fresh scoped manual intent without Git or synthetic qualification", async () => {
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  let sourceDrive: Promise<void> | undefined;
  let sourceRunId: string | undefined;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "4";
  await database.db
    .update(projects)
    .set({ repoPath: path.join(root, "unavailable-budget-repository") })
    .where(eq(projects.id, fixture.projectId));
  try {
    const body = await request("none");
    const principal = await interactiveTaskLaunchPrincipal();
    const original = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      body,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, original.intentId);

    if (!bound.runId)
      throw new Error(`NONE budget source did not bind: ${bound.reason}`);
    const runId = bound.runId;

    sourceRunId = runId;
    const { tryStartRun } = await import("@/lib/scheduler");
    const { startAgentSession } = await import("@/lib/agents/launch");

    expect((await tryStartRun(runId, { db: database.db })).started).toBe(true);
    fake.setPromptBehavior(() => new Promise(() => {}));
    sourceDrive = startAgentSession(runId, { db: database.db });
    await expect
      .poll(
        () =>
          fake
            .callsOf("sendPrompt")
            .some((call) => call.envelope?.fence.runId === runId),
        { timeout: 10_000 },
      )
      .toBe(true);
    await database.db
      .update(runs)
      .set({ status: "NeedsInput" })
      .where(eq(runs.id, runId));
    const hitlRequestId = randomUUID();

    await database.db.insert(hitlRequests).values({
      id: hitlRequestId,
      runId,
      stepId: "agent",
      kind: "budget_breach",
      prompt: "Decide on the budget",
      schema: {
        kind: "budget_breach",
        scope: "run",
        meter: "tokens",
        current: 120,
        limit: 100,
        decisions: ["raise", "abandon"],
      },
    });
    const firstPreview = await previewBudgetRestart(
      database.db,
      principal,
      runId,
      hitlRequestId,
    );
    const removeDrift = fake.onCall("checkpointSession", async () => {
      await database.db
        .update(tasks)
        .set({
          prompt: "Updated during checkpoint; requires a new decision",
          revision: sql`${tasks.revision}+1`,
        })
        .where(eq(tasks.id, body.taskId));
    });

    try {
      await expect(
        respondToHitl(
          {
            runId,
            hitlRequestId,
            body: { optionId: "restart", restartLaunch: firstPreview.request },
          },
          { kind: "user", userId: fixture.userId, label: "Fixture user" },
          { db: database.db, restartPrincipal: principal },
        ),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        details: { reason: "launch_input_changed" },
      });
    } finally {
      removeDrift();
    }
    const [paused] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId));
    const [failedClaim] = await database.db
      .select()
      .from(hitlRequests)
      .where(eq(hitlRequests.id, hitlRequestId));

    expect(["NeedsInput", "NeedsInputIdle"]).toContain(paused.status);
    expect(failedClaim).toMatchObject({
      respondedAt: null,
      response: { stage: "failed", restartLaunch: firstPreview.request },
    });
    expect(
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.taskId, body.taskId)),
    ).toHaveLength(1);
    const preview = await previewBudgetRestart(
      database.db,
      principal,
      runId,
      hitlRequestId,
    );

    expect(preview.prompt).toContain("Updated during checkpoint");
    expect(preview.request.expectedTaskRevision).toBe(
      firstPreview.request.expectedTaskRevision + 1,
    );
    const before = fake.callsOf("createSession").length;
    const response = await respondToHitl(
      {
        runId,
        hitlRequestId,
        body: { optionId: "restart", restartLaunch: preview.request },
      },
      { kind: "user", userId: fixture.userId, label: "Fixture user" },
      { db: database.db, restartPrincipal: principal },
    );
    const receipt = await response.json();

    await sourceDrive;

    expect(response.status).toBe(202);
    expect(receipt).toMatchObject({
      state: "restart_queued",
      runStatus: "Failed",
    });
    expect(fake.callsOf("createSession")).toHaveLength(before);
    const successor = await prepareTaskLaunchIntent(
      database.db,
      receipt.intentId,
    );

    if (!successor.runId)
      throw new Error(
        `NONE budget successor did not bind: ${successor.reason}`,
      );
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, receipt.intentId));
    const [next] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, successor.runId));

    expect(intent).toMatchObject({
      basis: { kind: "manual", userId: fixture.userId },
      operation: "retry",
      launchSource: "retry",
      sourceRunId: runId,
      settingsSnapshot: {
        kind: "agent",
        workspace: "none",
        baseCommit: null,
        serverExecution: {
          kind: "budget_restart",
          execution: { agentId: body.agentId },
        },
      },
    });
    expect(next).toMatchObject({
      agentId: body.agentId,
      agentWorkspace: "none",
      taskLaunchIntentId: intent.id,
      taskAdmissionSnapshot: {
        version: 2,
        basis: "manual",
        qualificationId: null,
      },
    });
    expect(next.triggerPayload).toMatchObject({
      kind: "budget_restart",
      oldRunId: runId,
      hitlRequestId,
    });
    expect(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.runId, next.id)),
    ).toHaveLength(0);
  } finally {
    if (sourceRunId) {
      const session = await loadActiveRunSession(database.db, sourceRunId);

      if (
        session?.hostSessionId &&
        fake.sessions.get(session.hostSessionId)?.status === "live"
      ) {
        const client = await createExecutionHosts({ db: database.db }).forRun(
          sourceRunId,
          { teardown: true },
        );

        await client.checkpoint(session.hostSessionId);
      }
    }
    await sourceDrive;
    fake.setPromptBehavior(async () => ({
      stopReason: "end_turn",
      meta: null,
    }));
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    await database.db
      .update(projects)
      .set({ repoPath: fixture.repo })
      .where(eq(projects.id, fixture.projectId));
  }
});

it("defers terminal cleanup while an accepted baseline owner is active and fences its late publication", async () => {
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  const { access } = await import("node:fs/promises");
  const { openAgentPreparation } =
    await import("@/lib/agents/preparation-workspace");
  const { captureOperationalBaseline } =
    await import("@/lib/agents/operational-integrity");
  const { taskAgentPreparationWorkspace } =
    await import("@/lib/tasks/launch-agent-execution");
  const { prepareUndispatchedAgentFailure } =
    await import("@/lib/agents/finalization");
  const { runPlainAgentDirectoryGcSweep } =
    await import("@/lib/gc/plain-agent-directory-gc");
  const { tryStartRun } = await import("@/lib/scheduler");
  const { addDetachedWorktree } = await import("@/lib/worktree");
  const { runContextMountGcSweep } = await import("@/lib/gc/context-mount-gc");
  const { releaseRunContextMounts } =
    await import("@/lib/context-mounts/terminal");

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "8";
  let owner: Awaited<ReturnType<typeof openAgentPreparation>> | null = null;

  try {
    const body = await request("none");
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      body,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    if (!bound.runId)
      throw new Error(`Accepted cleanup fixture did not bind: ${bound.reason}`);
    expect((await tryStartRun(bound.runId, { db: database.db })).started).toBe(
      true,
    );
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId));
    const descriptor = await taskAgentPreparationWorkspace(database.db, run);
    const marker = path.join(descriptor.cwd, "owned-baseline-input.txt");

    await mkdir(descriptor.cwd, { recursive: true });
    await writeFile(marker, "Preserve this while preparation owns it");
    const mountPath = path.join(
      root,
      ".maister",
      fixture.projectId,
      "runs",
      run.id,
      "context",
      fixture.projectId,
    );

    await mkdir(path.dirname(mountPath), { recursive: true });
    await addDetachedWorktree({
      projectRepoPath: fixture.repo,
      worktreePath: mountPath,
      committish: "HEAD",
    });
    await database.db
      .update(runs)
      .set({
        contextMounts: [
          {
            projectId: fixture.projectId,
            slug: fixture.projectId,
            repoPath: fixture.repo,
            mountPath,
            committish: "HEAD",
          },
        ],
      })
      .where(eq(runs.id, run.id));
    owner = await openAgentPreparation(database.db, {
      runId: run.id,
      assignmentId: run.executionAssignmentId!,
      ...descriptor,
    });
    const baseline = await owner.runEffect(() =>
      captureOperationalBaseline(descriptor.cwd, descriptor.resourceKind),
    );
    const terminal = await prepareUndispatchedAgentFailure(run.id, {
      db: database.db,
      expectedAssignmentId: run.executionAssignmentId!,
    });
    const terminalResult = await database.db.transaction(terminal.apply);

    expect(terminalResult.finalized).toBe(true);
    const busySweep = await runPlainAgentDirectoryGcSweep({
      candidates: [
        {
          runId: run.id,
          projectSlug: fixture.projectId,
          status: "Failed",
          taskLaunchIntentId: accepted.intentId,
        },
      ],
    });

    expect(busySweep.failed).toBe(1);
    await expect(
      releaseRunContextMounts({ runId: run.id, db: database.db }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const busyMountSweep = await runContextMountGcSweep({
      db: database.db,
      root,
    });

    expect(busyMountSweep.failed).toBeGreaterThanOrEqual(1);
    await expect(access(mountPath)).resolves.toBeUndefined();
    await expect(access(marker)).resolves.toBeUndefined();
    await expect(
      owner.publishBaseline({
        ...baseline,
        owner: {
          cwd: descriptor.cwd,
          repoPath: descriptor.repoPath,
          projectSlug: descriptor.projectSlug,
        },
      }),
    ).rejects.toMatchObject({ details: { reason: "assignment_fenced" } });
    await owner.release();
    owner = null;
    const completedSweep = await runPlainAgentDirectoryGcSweep({
      candidates: [
        {
          runId: run.id,
          projectSlug: fixture.projectId,
          status: "Failed",
          taskLaunchIntentId: accepted.intentId,
        },
      ],
    });

    expect(completedSweep.removed).toBe(1);
    const completedMountSweep = await runContextMountGcSweep({
      db: database.db,
      root,
      now: () => new Date(Date.now() + 120_000),
    });

    expect(completedMountSweep.removed).toBeGreaterThanOrEqual(1);
    await expect(access(mountPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const commands = await database.pool.query(
      "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [run.id],
    );

    expect(commands.rows[0].n).toBe(0);
  } finally {
    await owner?.release();
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

it("binds a current accepted automatic NONE target with real qualification evidence and no execution SHA", async () => {
  const { prepareTaskQualification } =
    await import("@/lib/tasks/qualification");
  const { qualificationFixture } =
    await import("@/test-support/task-qualification");
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "8";
  try {
    const body = await request("none");
    const assessment = await prepareTaskQualification(database.db, {
      projectId: fixture.projectId,
      taskId: body.taskId,
      author: {
        kind: "user",
        identity: fixture.userId,
        userId: fixture.userId,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: 1,
        expectedQualificationRevision: null,
        qualification: qualificationFixture(),
        enqueue: false,
      },
    });

    await database.db.transaction(assessment.apply);
    await database.db
      .update(tasks)
      .set({
        launchMode: "auto",
        launchIntent: "triage_then_launch",
        triageStatus: "triaged",
        triageFlagOrigin: null,
      })
      .where(eq(tasks.id, body.taskId));
    const [task] = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, body.taskId));
    const accepted = await acceptAutomaticTaskLaunch(
      database.db,
      {
        ...body,
        expectedTaskRevision: task.revision,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          task.id,
          body,
        ),
      },
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    expect(accepted.basis).toBe("automatic");
    expect(accepted.snapshot.baseCommit).toBeNull();
    expect(bound.state).toBe("run_bound");
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId!));

    if (intent.basis.kind !== "automatic")
      throw new Error("Automatic fixture lost its real assessment basis");
    expect(intent.basis.evidenceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(run.taskAdmissionSnapshot).toMatchObject({
      version: 2,
      basis: "automatic",
      mode: "required",
      evidenceSha: intent.basis.evidenceSha,
      qualificationId: intent.basis.qualificationId,
    });
    expect(intent.settingsSnapshot.baseCommit).toBeNull();
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

it("refuses a symlinked agent capture ancestor before any outside write or model command", async () => {
  const { access, readdir, rename, symlink, unlink } =
    await import("node:fs/promises");
  const { captureTaskAgentPackage } =
    await import("@/lib/tasks/launch-agent-definition");
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  const outside = await mkdtempReal("agent-capture-outside-");
  const originalOutsideEntries = await readdir(outside);
  const captureRoot = path.join(root, ".maister", "accepted-agent-captures");
  const savedRoot = `${captureRoot}-${randomUUID()}`;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "8";
  await mkdir(captureRoot, { recursive: true });
  await rename(captureRoot, savedRoot);
  await symlink(outside, captureRoot);
  try {
    const body = await request("none");
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      body,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    if (!bound.runId)
      throw new Error(
        `Capture containment fixture did not bind: ${bound.reason}`,
      );
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId));

    await expect(
      captureTaskAgentPackage(database.db, run),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      captureTaskAgentPackage(database.db, { ...run, id: "../outside" }),
    ).rejects.toMatchObject({
      details: { reason: "launch_capture_path_invalid" },
    });
    expect(await readdir(outside)).toEqual(originalOutsideEntries);
    await expect(access(path.join(outside, run.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const commands = await database.pool.query(
      "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [run.id],
    );

    expect(commands.rows[0].n).toBe(0);
  } finally {
    await unlink(captureRoot);
    await rename(savedRoot, captureRoot);
    await rm(outside, { recursive: true, force: true });
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

it("requires a fresh displayed manual decision for task-bound pre-work retry and binds through the common agent engine", async () => {
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "8";
  try {
    const { getAgentRetryOptions, acceptAgentRetry, getAgentRetryReceipt } =
      await import("@/lib/agents/retry");
    const { prepareUndispatchedAgentFailure } =
      await import("@/lib/agents/finalization");
    const { agentRetryIntents } = await import("@/lib/db/schema");
    const principal = await interactiveTaskLaunchPrincipal();
    const body = await request("none");
    const original = await acceptInteractiveTaskLaunch(
      database.db,
      principal,
      body,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, original.intentId);

    if (!bound.runId)
      throw new Error(`Retry source did not bind: ${bound.reason}`);
    const [source] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId));
    const terminal = await prepareUndispatchedAgentFailure(source.id, {
      db: database.db,
      expectedAssignmentId: source.executionAssignmentId!,
    });

    await database.db.transaction(terminal.apply);
    const { GET } = await import("@/app/api/runs/[runId]/retry-options/route");
    const { POST } = await import("@/app/api/runs/[runId]/retry/route");
    const params = { params: Promise.resolve({ runId: source.id }) };
    const optionsResponse = await GET(
      new Request(
        `http://local/runs/${source.id}/retry-options?runnerId=${encodeURIComponent(fixture.runnerId)}`,
      ),
      params,
    );
    const options: Awaited<ReturnType<typeof getAgentRetryOptions>> =
      await optionsResponse.json();

    expect(optionsResponse.status).toBe(200);

    expect(options).toMatchObject({
      eligible: true,
      launchRequest: {
        taskId: body.taskId,
        agentId: body.agentId,
        workspace: "none",
        relaunchOfRunId: source.id,
      },
    });
    if (!options.launchRequest || !options.selectedRunnerId)
      throw new Error("Retry preview omitted canonical request");
    const decision = {
      runnerId: options.selectedRunnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
      strategy: options.strategy,
      launchRequest: options.launchRequest,
    };

    await expect(
      acceptAgentRetry(database.db, source.id, fixture.userId, decision),
    ).rejects.toMatchObject({
      details: { reason: "launch_manual_authority_required" },
    });
    const acceptedResponse = await POST(
      new Request(`http://local/runs/${source.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      }),
      params,
    );
    const receipt: Awaited<ReturnType<typeof acceptAgentRetry>> =
      await acceptedResponse.json();

    expect(acceptedResponse.status).toBe(202);

    expect(receipt).toMatchObject({
      sourceRunId: source.id,
      runId: null,
      intentState: "accepted",
      cleanup: null,
    });
    expect(
      await database.db
        .select()
        .from(agentRetryIntents)
        .where(eq(agentRetryIntents.sourceRunId, source.id)),
    ).toHaveLength(0);
    const [accepted] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, receipt.retryIntentId));

    expect(accepted).toMatchObject({
      operation: "retry",
      launchSource: "retry",
      basis: { kind: "manual", userId: fixture.userId },
      sourceRunId: source.id,
      settingsSnapshot: {
        workspace: "none",
        serverExecution: {
          kind: "agent_retry",
          execution: { agentId: body.agentId },
        },
      },
    });
    const successor = await prepareTaskLaunchIntent(database.db, accepted.id);

    expect(successor.state).toBe("run_bound");
    expect(
      (
        await getAgentRetryReceipt(
          database.db,
          source.id,
          accepted.id,
          fixture.userId,
        )
      ).runId,
    ).toBe(successor.runId);
    await database.db
      .update(tasks)
      .set({
        prompt: "Changed after acceptance",
        revision: sql`${tasks.revision}+1`,
      })
      .where(eq(tasks.id, body.taskId));
    const replay = await acceptAgentRetry(
      database.db,
      source.id,
      fixture.userId,
      decision,
      principal,
    );

    expect(replay.retryIntentId).toBe(accepted.id);
    expect(replay.runId).toBe(successor.runId);
    const newer = await getAgentRetryOptions(
      database.db,
      source.id,
      fixture.userId,
    );

    expect(newer.eligible).toBe(false);
    expect(newer.existingIntentId).toBe(accepted.id);
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

it("dispatches a qualified domain-event-only NONE agent with its actual stored trigger", async () => {
  const { domainEvents } = await import("@/lib/db/schema");
  const { createStandaloneAgentTaskLaunchSource } =
    await import("@/lib/agents/flow-launch-authority");
  const { acceptServerTaskLaunch } = await import("@/lib/tasks/launch-intent");
  const { prepareTaskQualification } =
    await import("@/lib/tasks/qualification");
  const { qualificationFixture } =
    await import("@/test-support/task-qualification");
  const { tryStartRun } = await import("@/lib/scheduler");
  const { startAgentSession } = await import("@/lib/agents/launch");
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
  let stop: (() => void) | undefined;

  try {
    const body = await request("none");
    const assessment = await prepareTaskQualification(database.db, {
      projectId: fixture.projectId,
      taskId: body.taskId,
      author: {
        kind: "user",
        identity: fixture.userId,
        userId: fixture.userId,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: 1,
        expectedQualificationRevision: null,
        qualification: qualificationFixture(),
        enqueue: false,
      },
    });

    await database.db.transaction(assessment.apply);
    const [event] = await database.db
      .insert(domainEvents)
      .values({
        projectId: fixture.projectId,
        taskId: body.taskId,
        kind: "task.created",
        payload: {},
        actorType: "system",
        occurredAt: new Date(),
      })
      .returning();
    const source = await createStandaloneAgentTaskLaunchSource(database.db, {
      agentId: "launch-agents:events",
      projectId: fixture.projectId,
      taskId: body.taskId,
      workspace: "none",
      launchOverrideRunnerId: fixture.runnerId,
      trigger: {
        source: "domain_event",
        eventId: event.id,
        payload: { eventKind: event.kind },
      },
    });
    const launchRequest = await serverTaskLaunchRequest(database.db, source, {
      taskId: body.taskId,
      agentId: "launch-agents:events",
      workspace: "none",
      runnerId: fixture.runnerId,
    });
    const accepted = await acceptServerTaskLaunch(
      database.db,
      source,
      launchRequest,
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    expect(accepted.basis).toBe("automatic");
    expect(bound.state).toBe("run_bound");
    expect((await tryStartRun(bound.runId!, { db: database.db })).started).toBe(
      true,
    );
    let witnessed = false;

    stop = fake.onCall("createSession", async () => {
      const [intent] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, accepted.intentId));
      const [run] = await database.db
        .select()
        .from(runs)
        .where(eq(runs.id, bound.runId!));

      expect(intent.dispatchCommittedAt).not.toBeNull();
      expect(run).toMatchObject({
        triggerSource: "domain_event",
        triggerEventId: event.id,
        taskAdmissionSnapshot: { version: 2, basis: "automatic" },
      });
      expect(intent.settingsSnapshot).toMatchObject({
        kind: "agent",
        workspace: "none",
        baseCommit: null,
        serverExecution: {
          agentWorkspace: "none",
          execution: { triggerSource: "domain_event" },
        },
      });
      witnessed = true;
    });
    await startAgentSession(bound.runId!, {
      db: database.db,
      executionHosts: await createExecutionHosts({ db: database.db }),
    });
    expect(witnessed).toBe(true);
  } finally {
    stop?.();
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

it("uses a fresh private taskless Flow carrier and refuses its later edited input at dispatch", async () => {
  const { launchAgentRun } = await import("@/lib/agents/launch");
  const { tryStartRun } = await import("@/lib/scheduler");
  const { assertTaskAdmissionForDispatch } =
    await import("@/lib/tasks/qualification-admission");
  const { createTasklessAgentFlowCarrier } =
    await import("@/lib/agents/carrier-launch-authority");
  const { loadAgentContext } = await import("@/lib/agents/launch");
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
  try {
    const body = await request("worktree");
    const selection = { flowId: fixture.flowId, runnerId: fixture.runnerId };
    const blocker = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId: body.taskId,
        ...selection,
        expectedTaskRevision: body.expectedTaskRevision,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          body.taskId,
          selection,
        ),
      },
      randomUUID(),
    );
    const blockedRun = await prepareTaskLaunchIntent(
      database.db,
      blocker.intentId,
    );

    expect(blockedRun.state).toBe("run_bound");
    expect(
      (await tryStartRun(blockedRun.runId!, { db: database.db })).started,
    ).toBe(true);
    const original = {
      agentId: "launch-agents:facade",
      projectId: fixture.projectId,
      trigger: { source: "manual" as const },
      db: database.db,
    };
    const launched = await launchAgentRun(original);

    if ("deduped" in launched || "queued" in launched)
      throw new Error(
        "Fresh taskless carrier did not return its immediate private allocation",
      );
    expect(launched.status).toBe("Pending");
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, launched.runId));
    const [task] = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, run.taskId!));

    expect(task).toMatchObject({
      agentId: "launch-agents:facade",
      createdByUserId: null,
      qualificationMode: "required",
      currentQualificationId: null,
      revision: 0,
    });
    expect(run.taskAdmissionSnapshot).toMatchObject({
      version: 1,
      mode: "legacy",
      qualificationId: null,
      carrier: {
        agentId: "launch-agents:facade",
        inputSnapshot: {
          version: 2,
          taskId: task.id,
          prompt: "Follow the exact task.\n",
        },
      },
    });
    const context = await loadAgentContext(database.db, original);

    await expect(
      createTasklessAgentFlowCarrier(
        database.db,
        context,
        { ...original, taskId: task.id },
        fixture.flowId,
      ),
    ).rejects.toMatchObject({
      details: { reason: "agent_carrier_scope_changed" },
    });
    await database.db
      .update(tasks)
      .set({
        prompt: "A future request is a separate decision",
        revision: sql`${tasks.revision}+1`,
      })
      .where(eq(tasks.id, task.id));
    await expect(
      assertTaskAdmissionForDispatch(database.db, run.id),
    ).rejects.toMatchObject({
      details: { reason: "agent_carrier_scope_changed" },
    });
    const commands = await database.pool.query(
      "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
      [run.id],
    );

    expect(commands.rows[0].n).toBe(0);
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousCap;
  }
});

it("retains the accepted agent runner provenance when the engine injects its frozen runner", async () => {
  const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
  try {
    const body = await request("none");
    const { runnerId: _runnerId, ...selection } = body;
    const accepted = await acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      {
        ...selection,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          body.taskId,
          selection,
        ),
      },
      randomUUID(),
    );
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    expect(bound.state).toBe("run_bound");
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));
    const [session] = await database.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, bound.runId!));

    expect(intent.settingsSnapshot.sessions[0]).toMatchObject({
      runnerId: fixture.runnerId,
      runnerResolutionTier: "platformDefault",
    });
    expect(session).toMatchObject({
      runnerId: fixture.runnerId,
      runnerResolutionTier: "platformDefault",
      resolutionSource: "platformDefault",
    });
  } finally {
    if (previousCap === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
  }
});

async function acceptedAgentExecutionChildFixture() {
  const { domainEvents } = await import("@/lib/db/schema");
  const { createStandaloneAgentTaskLaunchSource } =
    await import("@/lib/agents/flow-launch-authority");
  const { acceptServerTaskLaunch } = await import("@/lib/tasks/launch-intent");
  const { establishExecutionChildAdmission } =
    await import("@/lib/tasks/qualification-admission");
  const { addTaskRelation } = await import("@/lib/social/relations");
  const { tryStartRun } = await import("@/lib/scheduler");
  const parentRequest = await request("worktree");
  const selection = { flowId: fixture.flowId, runnerId: fixture.runnerId };
  const acceptedParent = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId: parentRequest.taskId,
      ...selection,
      expectedTaskRevision: parentRequest.expectedTaskRevision,
      expectedSettingsToken: await taskLaunchSettingsToken(
        database.db,
        parentRequest.taskId,
        selection,
      ),
    },
    randomUUID(),
  );
  const parent = await prepareTaskLaunchIntent(
    database.db,
    acceptedParent.intentId,
  );

  expect(parent.runId).toBeTruthy();
  expect((await tryStartRun(parent.runId!, { db: database.db })).started).toBe(
    true,
  );
  const child = await request("none");

  await addTaskRelation(
    {
      projectId: fixture.projectId,
      fromTaskId: parentRequest.taskId,
      toTaskId: child.taskId,
      kind: "parent_of",
      actor: { type: "system", id: null },
    },
    database.db,
  );
  await database.db.transaction((tx) =>
    establishExecutionChildAdmission(
      tx as unknown as import("@/lib/execution-host/db").Db,
      {
        projectId: fixture.projectId,
        parentRunId: parent.runId!,
        childTaskId: child.taskId,
        planRevision: "agent-child-fixture-v1",
      },
    ),
  );
  const [event] = await database.db
    .insert(domainEvents)
    .values({
      projectId: fixture.projectId,
      taskId: child.taskId,
      kind: "task.created",
      payload: {},
      actorType: "system",
      occurredAt: new Date(),
    })
    .returning();
  const source = await createStandaloneAgentTaskLaunchSource(database.db, {
    agentId: "launch-agents:events",
    projectId: fixture.projectId,
    taskId: child.taskId,
    workspace: "none",
    launchOverrideRunnerId: fixture.runnerId,
    parentRunId: parent.runId!,
    rootRunId: parent.runId!,
    launchMode: "auto",
    trigger: { source: "domain_event", eventId: event.id },
  });
  const accepted = await acceptServerTaskLaunch(
    database.db,
    source,
    await serverTaskLaunchRequest(database.db, source, {
      taskId: child.taskId,
      agentId: "launch-agents:events",
      workspace: "none",
      runnerId: fixture.runnerId,
    }),
    randomUUID(),
  );

  return { parent, child, accepted };
}

it("binds an admitted NONE execution child with parent lineage without counting its own preparing reservation twice", async () => {
  const previousAgents = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  const previousFlows = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const previousFanout = process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "12";
  process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";
  try {
    const { parent, accepted } = await acceptedAgentExecutionChildFixture();
    const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

    expect(accepted.basis).toBe("execution_child");
    expect(bound.state).toBe("run_bound");
    const [run] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, bound.runId!));

    expect(run).toMatchObject({
      parentRunId: parent.runId,
      rootRunId: parent.runId,
      launchMode: "auto",
      taskAdmissionSnapshot: {
        version: 2,
        basis: "execution_child",
        parent: { parentRunId: parent.runId },
      },
    });
    expect(
      await database.db
        .select()
        .from(runs)
        .where(eq(runs.parentRunId, parent.runId!)),
    ).toHaveLength(1);
  } finally {
    if (previousAgents === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousAgents;
    if (previousFlows === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousFlows;
    if (previousFanout === undefined)
      delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
    else process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = previousFanout;
  }
});

it.each([
  { change: "proof_changed", phase: "queued" },
  { change: "parent_terminal", phase: "queued" },
  { change: "proof_changed", phase: "bound" },
  { change: "parent_terminal", phase: "bound" },
] as const)(
  "holds a $phase agent child after $change without changing its frozen basis or dispatching the model",
  async ({ change, phase }) => {
    const { establishExecutionChildAdmission } =
      await import("@/lib/tasks/qualification-admission");
    const previousAgents = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    const previousFlows = process.env.MAISTER_MAX_CONCURRENT_RUNS;
    const previousFanout = process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "12";
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";
    try {
      const { parent, child, accepted } =
        await acceptedAgentExecutionChildFixture();
      const [before] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, accepted.intentId));
      const [originalTask] = await database.db
        .select()
        .from(tasks)
        .where(eq(tasks.id, child.taskId));

      if (phase === "bound") {
        const bound = await prepareTaskLaunchIntent(
          database.db,
          accepted.intentId,
        );

        expect(bound.state).toBe("run_bound");
      }
      if (change === "proof_changed") {
        await database.db.transaction((tx) =>
          establishExecutionChildAdmission(
            tx as unknown as import("@/lib/execution-host/db").Db,
            {
              projectId: fixture.projectId,
              parentRunId: parent.runId!,
              childTaskId: child.taskId,
              planRevision: "agent-child-fixture-v2",
            },
          ),
        );
        const [changedTask] = await database.db
          .select()
          .from(tasks)
          .where(eq(tasks.id, child.taskId));

        expect(changedTask.prompt).toBe(originalTask.prompt);
        expect(changedTask.revision).toBe(originalTask.revision);
        expect(changedTask.qualificationInputRevision).toBe(
          originalTask.qualificationInputRevision,
        );
      } else
        await database.db
          .update(runs)
          .set({ status: "Abandoned", endedAt: new Date() })
          .where(eq(runs.id, parent.runId!));
      if (phase === "bound") {
        const { dispatchBoundTaskLaunchIntent } =
          await import("@/lib/tasks/launch-dispatch");

        await dispatchBoundTaskLaunchIntent(database.db, accepted.intentId);
      } else await prepareTaskLaunchIntent(database.db, accepted.intentId);
      const [after] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, accepted.intentId));

      expect(after).toMatchObject({
        state: "held",
        reason:
          change === "proof_changed"
            ? "qualification_child_stale"
            : "qualification_parent_unavailable",
      });
      expect(after.basis).toEqual(before.basis);
      expect(after.inputSnapshot).toEqual(before.inputSnapshot);
      expect(after.settingsSnapshot).toEqual(before.settingsSnapshot);
      const commands = await database.pool.query(
        "SELECT count(*)::int n FROM execution_commands WHERE run_id=$1 AND kind IN ('session.create','session.prompt')",
        [after.preparationIdentity?.runId ?? after.runId],
      );

      expect(commands.rows[0].n).toBe(0);
    } finally {
      if (previousAgents === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousAgents;
      if (previousFlows === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
      else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousFlows;
      if (previousFanout === undefined)
        delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
      else process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = previousFanout;
    }
  },
);

it.each([
  {
    agentId: "launch-agents:delivery",
    workspace: "none" as const,
    kind: "agent",
  },
  { agentId: "launch-agents:facade", kind: "flow" },
])(
  "queues the public $kind task agent through automatic admission instead of impersonating a manual decision",
  async (target) => {
    const { launchAgentRun } = await import("@/lib/agents/launch");
    const { prepareTaskQualification } =
      await import("@/lib/tasks/qualification");
    const { qualificationFixture } =
      await import("@/test-support/task-qualification");
    const body = await request("none");
    const launchInput = {
      agentId: target.agentId,
      projectId: fixture.projectId,
      taskId: body.taskId,
      ...(target.workspace ? { workspace: target.workspace } : {}),
      trigger: { source: "manual" as const },
      db: database.db,
    };

    await expect(launchAgentRun(launchInput)).rejects.toMatchObject({
      details: { reason: "qualification_required" },
    });
    expect(
      await database.db.select().from(runs).where(eq(runs.taskId, body.taskId)),
    ).toHaveLength(0);
    const assessment = await prepareTaskQualification(database.db, {
      projectId: fixture.projectId,
      taskId: body.taskId,
      author: {
        kind: "user",
        identity: fixture.userId,
        userId: fixture.userId,
      },
      request: {
        requestKey: randomUUID(),
        expectedInputRevision: 1,
        expectedQualificationRevision: null,
        qualification: qualificationFixture(),
        enqueue: false,
      },
    });

    await database.db.transaction(assessment.apply);
    const first = await launchAgentRun(launchInput);

    if (!("queued" in first))
      throw new Error("Public task agent bypassed durable intent admission");
    expect(first.receipt).toMatchObject({
      basis: "automatic",
      state: "queued",
      runId: null,
      snapshot: { kind: target.kind },
    });
    const replay = await launchAgentRun(launchInput);

    expect(replay).toEqual(first);
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, first.receipt.intentId));

    expect(intent).toMatchObject({
      principalKind: "system",
      actorUserId: null,
      basis: { kind: "automatic" },
    });
    expect(
      await database.db.select().from(runs).where(eq(runs.taskId, body.taskId)),
    ).toHaveLength(0);
  },
);

it("prepares and reuses the actual writable shared child tree while retaining its original seed after both HEADs advance", async () => {
  const { launchAgentRun, startAgentSession } =
    await import("@/lib/agents/launch");
  const { establishExecutionChildAdmission } =
    await import("@/lib/tasks/qualification-admission");
  const { addTaskRelation } = await import("@/lib/social/relations");
  const { findSharedTreeWorkspace } = await import("@/lib/runs/shared-tree");
  const { commitFile, resolveBaseCommit } = await import("@/lib/worktree");
  const { stat, readFile } = await import("node:fs/promises");
  const { tryStartRun } = await import("@/lib/scheduler");
  const previousAgents = process.env.MAISTER_MAX_CONCURRENT_AGENTS;
  const previousFlows = process.env.MAISTER_MAX_CONCURRENT_RUNS;
  const previousFanout = process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;

  process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
  process.env.MAISTER_MAX_CONCURRENT_RUNS = "12";
  process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "4";
  try {
    const { parent } = await acceptedAgentExecutionChildFixture();
    const [parentRun] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, parent.runId!));
    const createSharedChild = async () => {
      const child = await request("none");

      await addTaskRelation(
        {
          projectId: fixture.projectId,
          fromTaskId: parentRun.taskId!,
          toTaskId: child.taskId,
          kind: "parent_of",
          actor: { type: "system", id: null },
        },
        database.db,
      );
      await database.db.transaction((tx) =>
        establishExecutionChildAdmission(
          tx as unknown as import("@/lib/execution-host/db").Db,
          {
            projectId: fixture.projectId,
            parentRunId: parent.runId!,
            childTaskId: child.taskId,
            planRevision: "shared-child-plan-v1",
          },
        ),
      );
      const result = await launchAgentRun({
        agentId: "launch-agents:events",
        projectId: fixture.projectId,
        taskId: child.taskId,
        workspace: "worktree",
        workspaceMode: "shared",
        parentRunId: parent.runId!,
        rootRunId: parent.runId!,
        trigger: { source: "domain_event" },
        db: database.db,
      });

      if (!("queued" in result))
        throw new Error("Shared child did not enter durable admission");
      const bound = await prepareTaskLaunchIntent(
        database.db,
        result.receipt.intentId,
      );

      expect(bound.state).toBe("run_bound");

      return { receipt: result.receipt, runId: bound.runId! };
    };
    const first = await createSharedChild();

    expect((await tryStartRun(first.runId, { db: database.db })).started).toBe(
      true,
    );
    await startAgentSession(first.runId, {
      db: database.db,
      executionHosts: await createExecutionHosts({ db: database.db }),
    });
    const owner = await findSharedTreeWorkspace(database.db, parent.runId!);

    if (!owner)
      throw new Error("Shared allocator did not persist the root workspace");
    const [workspace] = await database.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, owner.id));
    const inode = (await stat(workspace.worktreePath)).ino;
    const marker = path.join(workspace.worktreePath, "shared-owner-proof.txt");

    await writeFile(marker, "Retain the existing shared root bytes\n");
    await commitFile({
      repo: workspace.worktreePath,
      file: "shared-owner-proof.txt",
      message: "Shared child proof",
    });
    const sharedHead = await resolveBaseCommit({
      projectRepoPath: workspace.worktreePath,
      baseRef: "HEAD",
    });

    await writeFile(
      path.join(fixture.repo, "later-main-proof.txt"),
      "A later main revision\n",
    );
    await commitFile({
      repo: fixture.repo,
      file: "later-main-proof.txt",
      message: "Later main proof",
    });
    const mainHead = await resolveBaseCommit({
      projectRepoPath: fixture.repo,
      baseRef: "HEAD",
    });

    expect(sharedHead).not.toBe(workspace.baseCommit);
    expect(mainHead).not.toBe(workspace.baseCommit);
    const second = await createSharedChild();
    const [secondIntent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, second.receipt.intentId));

    expect(secondIntent.settingsSnapshot).toMatchObject({
      baseCommit: workspace.baseCommit,
      agentSnapshot: {
        sharedRoot: {
          workspaceId: workspace.id,
          baseCommit: workspace.baseCommit,
        },
      },
    });
    expect(
      await database.db
        .select()
        .from(workspaces)
        .where(eq(workspaces.runId, second.runId)),
    ).toHaveLength(0);
    expect((await tryStartRun(second.runId, { db: database.db })).started).toBe(
      true,
    );
    await startAgentSession(second.runId, {
      db: database.db,
      executionHosts: await createExecutionHosts({ db: database.db }),
    });
    const [secondRun] = await database.db
      .select()
      .from(runs)
      .where(eq(runs.id, second.runId));
    const [secondPrepared] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, second.receipt.intentId));

    const [preparationDiagnostic] = await database.db
      .select({ failure: agentPreparationOperations.failure })
      .from(agentPreparationOperations)
      .where(eq(agentPreparationOperations.runId, second.runId));

    expect(
      secondPrepared.dispatchCommittedAt,
      JSON.stringify(preparationDiagnostic?.failure),
    ).not.toBeNull();
    expect(secondRun.operationalIntegrityBaseline?.owner?.cwd).toBe(
      workspace.worktreePath,
    );
    expect((await stat(workspace.worktreePath)).ino).toBe(inode);
    expect(await readFile(marker, "utf8")).toBe(
      "Retain the existing shared root bytes\n",
    );
    expect(
      await resolveBaseCommit({
        projectRepoPath: workspace.worktreePath,
        baseRef: "HEAD",
      }),
    ).toBe(sharedHead);
    expect(
      (await findSharedTreeWorkspace(database.db, parent.runId!))?.id,
    ).toBe(workspace.id);
  } finally {
    if (previousAgents === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
    else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousAgents;
    if (previousFlows === undefined)
      delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
    else process.env.MAISTER_MAX_CONCURRENT_RUNS = previousFlows;
    if (previousFanout === undefined)
      delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
    else process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = previousFanout;
  }
});

async function queuedReservedAgentFixture(
  triggerSource: "cron" | "domain_event",
) {
  const { agentSchedules, domainEvents } = await import("@/lib/db/schema");
  const { claimCronAgentAttempt, claimEventAgentAttempt } =
    await import("@/lib/agents/trigger-attempts");
  const { launchAgentRun } = await import("@/lib/agents/launch");
  const { prepareTaskQualification } =
    await import("@/lib/tasks/qualification");
  const { qualificationFixture } =
    await import("@/test-support/task-qualification");
  const body = await request("none");
  const assessment = await prepareTaskQualification(database.db, {
    projectId: fixture.projectId,
    taskId: body.taskId,
    author: { kind: "user", identity: fixture.userId, userId: fixture.userId },
    request: {
      requestKey: randomUUID(),
      expectedInputRevision: 1,
      expectedQualificationRevision: null,
      qualification: qualificationFixture(),
      enqueue: false,
    },
  });

  await database.db.transaction(assessment.apply);
  const agentId =
    triggerSource === "cron" ? "launch-agents:cron" : "launch-agents:events";
  const scheduleId = randomUUID();
  const claimedAt = new Date();

  await database.db.insert(agentSchedules).values({
    id: scheduleId,
    projectId: fixture.projectId,
    agentId,
    triggerType: triggerSource === "cron" ? "cron" : "event",
    cronExpr: triggerSource === "cron" ? "* * * * *" : null,
    timezone: triggerSource === "cron" ? "UTC" : null,
    nextFireAt: triggerSource === "cron" ? claimedAt : null,
    eventMatch:
      triggerSource === "domain_event" ? { kinds: ["task.created"] } : null,
  });
  const [event] = await database.db
    .insert(domainEvents)
    .values({
      projectId: fixture.projectId,
      taskId: body.taskId,
      kind: "task.created",
      payload: {},
      actorType: "system",
      occurredAt: claimedAt,
    })
    .returning();
  const attempt =
    triggerSource === "cron"
      ? await claimCronAgentAttempt(
          database.db,
          scheduleId,
          claimedAt,
          new Date(claimedAt.getTime() + 60_000),
        )
      : await claimEventAgentAttempt(
          database.db,
          scheduleId,
          claimedAt,
          event.id,
        );

  if (!attempt)
    throw new Error("Actual scheduled source did not acquire its durable fire");
  const input = {
    agentId,
    projectId: fixture.projectId,
    taskId: body.taskId,
    workspace: "none" as const,
    runId: attempt.reservedRunId,
    agentScheduleId: scheduleId,
    ...(triggerSource === "cron"
      ? {
          agentTriggerReservation: {
            attemptId: attempt.id,
            runId: attempt.reservedRunId,
          },
        }
      : {}),
    trigger: {
      source: triggerSource,
      eventId: triggerSource === "domain_event" ? event.id : null,
    },
    db: database.db,
  };
  const launched = await launchAgentRun(input);

  if (!("queued" in launched))
    throw new Error("Scheduled task agent bypassed durable intent admission");

  return { body, agentId, attempt, input, launched, claimedAt };
}

it.each(["cron", "domain_event"] as const)(
  "hands the actual %s reservation to the accepted intent before the producer claim expires",
  async (triggerSource) => {
    const { agentTriggerAttempts } = await import("@/lib/db/schema");
    const { launchAgentRun } = await import("@/lib/agents/launch");
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
    try {
      const { body, attempt, input, launched, claimedAt } =
        await queuedReservedAgentFixture(triggerSource);
      const [acknowledged] = await database.db
        .select()
        .from(agentTriggerAttempts)
        .where(eq(agentTriggerAttempts.id, attempt.id));

      expect(acknowledged).toMatchObject({
        outcome: "queued",
        runId: null,
        originalRunId: null,
      });
      expect(acknowledged.settledAt).not.toBeNull();
      await database.db
        .update(agentTriggerAttempts)
        .set({ dueAt: new Date(claimedAt.getTime() - 60_000) })
        .where(eq(agentTriggerAttempts.id, attempt.id));
      expect(await launchAgentRun(input)).toEqual(launched);
      const bound = await prepareTaskLaunchIntent(
        database.db,
        launched.receipt.intentId,
      );

      expect(bound).toMatchObject({
        state: "run_bound",
        runId: attempt.reservedRunId,
      });
      const [receipt] = await database.db
        .select()
        .from(agentTriggerAttempts)
        .where(eq(agentTriggerAttempts.id, attempt.id));

      expect(receipt).toMatchObject({
        outcome: "queued",
        runId: attempt.reservedRunId,
        originalRunId: attempt.reservedRunId,
      });
      expect(
        await database.db
          .select()
          .from(runs)
          .where(eq(runs.taskId, body.taskId)),
      ).toHaveLength(1);
    } finally {
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    }
  },
);

it.each(["held", "cancelled"] as const)(
  "projects current %s intent ownership for an acknowledged trigger with no Run",
  async (state) => {
    const { getAgentAttemptHistory } =
      await import("@/lib/agents/activity-queries");
    const { cancelInteractiveTaskLaunch } =
      await import("@/lib/tasks/launch-cancel");
    const { agentTriggerAttempts } = await import("@/lib/db/schema");
    const previousCap = process.env.MAISTER_MAX_CONCURRENT_AGENTS;

    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "32";
    try {
      const { body, agentId, attempt, launched } =
        await queuedReservedAgentFixture("domain_event");

      if (state === "held") {
        await database.db
          .update(tasks)
          .set({
            prompt: "A changed request must be reviewed",
            revision: sql`${tasks.revision}+1`,
          })
          .where(eq(tasks.id, body.taskId));
        expect(
          (
            await prepareTaskLaunchIntent(
              database.db,
              launched.receipt.intentId,
            )
          ).state,
        ).toBe("held");
      } else
        await cancelInteractiveTaskLaunch(
          database.db,
          await interactiveTaskLaunchPrincipal(),
          launched.receipt.intentId,
          { expectedStateVersion: launched.receipt.stateVersion },
          randomUUID(),
        );
      const history = await getAgentAttemptHistory(database.db, {
        projectId: fixture.projectId,
        agentId,
        limit: 100,
      });
      const projected = history.items.find(
        (item) => item.attemptId === attempt.id,
      );
      const [trigger] = await database.db
        .select()
        .from(agentTriggerAttempts)
        .where(eq(agentTriggerAttempts.id, attempt.id));

      expect(projected).toMatchObject({
        outcome: "queued",
        runId: null,
        launchIntent: {
          intentId: launched.receipt.intentId,
          taskId: body.taskId,
          state,
        },
      });
      expect(projected?.launchIntent?.taskNumber).toBeGreaterThan(0);
      expect(trigger.outcome).toBe("queued");
      expect(
        await database.db
          .select()
          .from(runs)
          .where(eq(runs.taskId, body.taskId)),
      ).toHaveLength(0);
    } finally {
      if (previousCap === undefined)
        delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
      else process.env.MAISTER_MAX_CONCURRENT_AGENTS = previousCap;
    }
  },
);
