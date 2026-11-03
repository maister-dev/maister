import type { ScheduledAgentRequestSnapshot } from "@/lib/agents/scheduled-request";

import { randomUUID } from "node:crypto";
import { rm, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  getAgentRetryOptions,
  acceptAgentRetry,
  runAgentRetryAdmissionSweep,
  getAgentRetryReceipt,
} from "@/lib/agents/retry";
import { prepareUndispatchedAgentFailure } from "@/lib/agents/finalization";
import { runs, runSessions, platformAcpRunners } from "@/lib/db/schema";
import { allocateAgentRetryWorktree } from "@/lib/agents/retry-allocation";
import { agentWorkdirPath } from "@/lib/agents/workspace-paths";
import { agentWorktreeBranchName, buildAgentPrompt } from "@/lib/agents/launch";
import { git } from "@/test-support/git-fixture";
import * as worktreeLifecycle from "@/lib/worktree";
import { rearmAgentRetryCleanup } from "@/lib/agents/retry";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { testRunnerSnapshot } from "@/lib/__tests__/runner-fixtures";
import { seedAgentRun } from "@/test-support/agent-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { loadTaskQualificationInput } from "@/lib/tasks/qualification";
import { qualificationFixture } from "@/test-support/task-qualification";
import { insertCommand } from "@/lib/execution-host/commands";
import {
  prepareAgentRetry,
  retryRecipeFor,
  retryDigest,
} from "@/lib/agents/retry-preparation";
import { agentRetryIntents } from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/scheduler", async (original) => ({
  ...(await original<typeof import("@/lib/scheduler")>()),
  tryStartRun: async () => ({ started: false, queuePosition: 1 }),
}));
let database: StartedPostgresTestDb;
let sessionUserId: string | null = null;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: sessionUserId, role: "member" }),
}));
let root: string;
const previousRoot = process.env.MAISTER_WORKTREES_ROOT;

beforeAll(async () => {
  database = await startMainPostgresTestDb({ databaseName: "agent_retry" });
  root = await mkdtempReal("agent-retry-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  await fakeExecutionHosts(database.db);
}, 180_000);

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = previousRoot;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(
  workspace: "none" | "worktree" = "none",
  scheduledRequestSnapshot?: ScheduledAgentRequestSnapshot,
): Promise<{
  runId: string;
  userId: string;
  projectId: string;
  runnerId: string;
}> {
  const runId = await seedAgentRun(database.db, {
    runtimeRoot: root,
    scheduledRequestSnapshot,
    definition: `---\nname: Researcher\ndescription: inspect\nmode: session\nworkspace: ${workspace}\ntriggers: [manual, cron]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect the task.`,
    workspace,
    resultContract: null,
  });

  return finishedFixture(runId);
}

async function finishedFixture(runId: string): Promise<{
  runId: string;
  userId: string;
  projectId: string;
  runnerId: string;
}> {
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
  const prepared = await prepareUndispatchedAgentFailure(runId, {
    db: database.db,
    reason: "agent_dispatch_failed",
  });

  await database.db.transaction(prepared.apply);

  return {
    runId,
    userId,
    projectId: run.projectId!,
    runnerId: session.runnerId!,
  };
}

it("accepts a positively proven operational pre-dispatch failure even when its outcome cause is operational_execution_failed", async () => {
  const runId = await seedAgentRun(database.db, {
    runtimeRoot: root,
    definition:
      "---\nname: Operator\ndescription: inspect\nkind: operational\ncompletion: {contract: operational_v1}\nmode: session\nworkspace: none\ntriggers: [manual]\nrisk_tier: read_only\nplatform_mcp: false\n---\nInspect.",
    workspace: "none",
    resultContract: null,
    operational: true,
  });
  const source = await finishedFixture(runId);
  const options = await getAgentRetryOptions(database.db, runId, source.userId);

  expect(options).toMatchObject({ eligible: true, reason: null });
  expect(
    (
      await database.pool.query(
        "SELECT payload->>'failurePhase' phase FROM domain_events WHERE run_id=$1 AND kind='run.failed' ORDER BY occurred_at DESC LIMIT 1",
        [runId],
      )
    ).rows[0].phase,
  ).toBe("before_dispatch");
});

async function failedQualificationFixture(): Promise<
  Awaited<ReturnType<typeof fixture>> & { taskId: string; agentId: string }
> {
  const runId = await seedAgentRun(database.db, {
    runtimeRoot: root,
    definition:
      "---\nname: Qualifier\ndescription: qualify\nkind: operational\ncompletion: {contract: operational_v1}\ntask_qualification: {contract: v1, role: qualifier}\nmode: session\nworkspace: repo_read\nworkspace_ref: task_target\ntriggers: [manual, domain_event]\nrisk_tier: read_only\nplatform_mcp: false\n---\nAssess the current task.",
    workspace: "repo_read",
    resultContract: null,
  });
  const source = await finishedFixture(runId);
  const taskId = randomUUID();
  const agent = await database.pool.query(
    "SELECT agent_id FROM runs WHERE id=$1",
    [runId],
  );

  await database.pool.query(
    "UPDATE package_installs SET manifest=jsonb_build_object('spec',jsonb_build_object('schemaVersion',1,'name',name,'flows','[]'::jsonb,'capabilities','[]'::jsonb,'compat','{\"engine_min\":\"3.10.0\"}'::jsonb),'inventory','{\"skills\":[],\"agents\":[],\"platformAgents\":[\"researcher\"]}'::jsonb) WHERE id=(SELECT package_install_id FROM project_package_attachments WHERE project_id=$1)",
    [source.projectId],
  );
  await database.pool.query(
    "INSERT INTO tasks(id,project_id,number,title,prompt,triage_status) VALUES ($1,$2,1,'Imported issue','Inspect the issue','triaged')",
    [taskId, source.projectId],
  );
  await database.pool.query(
    "UPDATE projects SET task_qualification_override='required' WHERE id=$1",
    [source.projectId],
  );
  await database.pool.query(
    "UPDATE runs SET task_id=$2,trigger_source='domain_event',trigger_payload='{\"kind\":\"task.created\"}' WHERE id=$1",
    [runId, taskId],
  );
  await database.pool.query(
    "UPDATE run_sessions SET acp_session_id='legacy-failed-claude-session' WHERE run_id=$1",
    [runId],
  );

  return { ...source, taskId, agentId: agent.rows[0].agent_id as string };
}

it("prepares a fresh current-task qualification for a legacy failed triager, opts the task in, and prevents duplicate old-run attempts", async () => {
  const source = await failedQualificationFixture();
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );

  expect(options).toMatchObject({
    eligible: true,
    reason: null,
    strategy: "fresh_qualification",
    qualificationOptIn: true,
    selectedRunnerId: source.runnerId,
  });
  const request = {
    runnerId: source.runnerId,
    requestKey: randomUUID(),
    previewFingerprint: options.previewFingerprint,
    strategy: "fresh_qualification",
  };
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    request,
  );

  expect(receipt.intentState).toBe("accepted");
  expect(
    (
      await database.pool.query(
        "SELECT qualification_mode,qualification_input_revision FROM tasks WHERE id=$1",
        [source.taskId],
      )
    ).rows[0],
  ).toEqual({
    qualification_mode: "required",
    qualification_input_revision: 1,
  });
  expect(
    await acceptAgentRetry(database.db, source.runId, source.userId, request),
  ).toEqual(receipt);
  await runAgentRetryAdmissionSweep(database.db);
  const settled = await getAgentRetryReceipt(
    database.db,
    source.runId,
    receipt.retryIntentId,
    source.userId,
  );

  expect(settled).toMatchObject({
    intentState: "launched",
    runStatus: "Pending",
  });
  const successor = (
    await database.pool.query(
      "SELECT task_id,trigger_source,task_qualification_snapshot FROM runs WHERE id=$1",
      [settled.runId],
    )
  ).rows[0];

  expect(successor).toMatchObject({
    task_id: source.taskId,
    trigger_source: "manual",
    task_qualification_snapshot: { role: "qualifier", taskId: source.taskId },
  });
  const recipe = (
    await database.pool.query(
      "SELECT recipe FROM agent_retry_intents WHERE id=$1",
      [receipt.retryIntentId],
    )
  ).rows[0].recipe;

  expect(successor.task_qualification_snapshot.sha).toBe(
    recipe.qualificationSha,
  );
  const [successorRun] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, settled.runId!));

  expect(successorRun.executionPolicy).toEqual(recipe.policy);
  expect(successorRun.agentConfig ?? {}).toEqual(recipe.configuration);
  const prompt = await buildAgentPrompt(
    database.db,
    recipe.definition.parsed,
    successorRun,
  );

  expect(prompt).toContain("## Fresh qualification request");
  expect(
    await buildAgentPrompt(database.db, recipe.definition.parsed, {
      ...successorRun,
      agentActivitySnapshot: {
        ...successorRun.agentActivitySnapshot,
        retryOrigin: {
          sourceRunId: source.runId,
          intentId: receipt.retryIntentId,
          originalEventId: null,
        },
      },
    }),
  ).not.toContain("## Fresh qualification request");
  expect(
    (
      await database.pool.query(
        "SELECT acp_session_id FROM run_sessions WHERE run_id=$1",
        [source.runId],
      )
    ).rows[0].acp_session_id,
  ).toBe("legacy-failed-claude-session");
});

it("refuses a fresh assessment if its target moves between delivery preparation and launch", async () => {
  const source = await failedQualificationFixture();
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
      strategy: "fresh_qualification",
    },
  );
  const resolve = worktreeLifecycle.resolveBaseCommit;
  let resolutions = 0;
  const race = vi
    .spyOn(worktreeLifecycle, "resolveBaseCommit")
    .mockImplementation(async (input) => {
      resolutions += 1;
      if (resolutions === 2)
        await git(
          input.projectRepoPath,
          "commit",
          "--allow-empty",
          "-m",
          "Advance qualification target during launch",
        );

      return resolve(input);
    });

  try {
    await runAgentRetryAdmissionSweep(database.db);
  } finally {
    race.mockRestore();
  }
  const settled = await getAgentRetryReceipt(
    database.db,
    source.runId,
    receipt.retryIntentId,
    source.userId,
  );

  expect(resolutions).toBe(2);
  expect(settled).toMatchObject({
    intentState: "refused",
    refusalReason: "retry_context_changed",
    runId: null,
  });
});

it("uses the changed configured runner and serializes different failed sources for the same task into one assessment", async () => {
  const source = await failedQualificationFixture();
  const alternativeId = randomUUID();
  const alternative = testRunnerSnapshot(alternativeId, "codex");

  await database.db.insert(platformAcpRunners).values({
    id: alternativeId,
    adapter: "codex",
    capabilityAgent: "codex",
    model: alternative.model,
    provider: { kind: "openai" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  await database.pool.query(
    "UPDATE agent_project_links SET runner_override_id=$2 WHERE project_id=$1",
    [source.projectId, alternativeId],
  );
  const [original] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, source.runId));
  const otherRunId = randomUUID();

  await database.db.insert(runs).values({ ...original, id: otherRunId });
  const first = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );
  const second = await getAgentRetryOptions(
    database.db,
    otherRunId,
    source.userId,
  );

  expect(first.selectedRunnerId).toBe(alternativeId);
  const requests = [
    { sourceRunId: source.runId, options: first },
    { sourceRunId: otherRunId, options: second },
  ];
  const outcomes = await Promise.allSettled(
    requests.map((item) =>
      acceptAgentRetry(database.db, item.sourceRunId, source.userId, {
        runnerId: alternativeId,
        requestKey: randomUUID(),
        previewFingerprint: item.options.previewFingerprint,
        strategy: "fresh_qualification",
      }),
    ),
  );

  expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.find((item) => item.status === "rejected")).toMatchObject({
    reason: { details: { reason: "retry_task_busy" } },
  });
  await runAgentRetryAdmissionSweep(database.db);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int total FROM runs WHERE task_id=$1 AND status='Pending'",
        [source.taskId],
      )
    ).rows[0].total,
  ).toBe(1);
});

it("refuses unresolved source commands and active task work", async () => {
  const unresolved = await failedQualificationFixture();
  const assignment = (
    await database.pool.query(
      "SELECT * FROM execution_assignments WHERE run_id=$1 ORDER BY epoch DESC LIMIT 1",
      [unresolved.runId],
    )
  ).rows[0];

  await insertCommand(database.db, {
    runId: unresolved.runId,
    assignmentId: assignment.id,
    hostId: assignment.execution_host_id,
    assignmentEpoch: assignment.epoch,
    kind: "session.cancel",
    payload: {},
    maxAttempts: 3,
  });
  expect(
    await getAgentRetryOptions(
      database.db,
      unresolved.runId,
      unresolved.userId,
    ),
  ).toMatchObject({ eligible: false, reason: "reconciliation_required" });
  const active = await failedQualificationFixture();
  const [old] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, active.runId));

  await database.db
    .insert(runs)
    .values({ ...old, id: randomUUID(), status: "Running", endedAt: null });
  expect(
    await getAgentRetryOptions(database.db, active.runId, active.userId),
  ).toMatchObject({ eligible: false, reason: "retry_task_busy" });
});

it.each(["ready", "needs_information"] as const)(
  "skips an accepted current %s assessment and permits reassessment after repository evidence changes",
  async (decision) => {
    const complete = await failedQualificationFixture();
    const repo = (
      await database.pool.query("SELECT repo_path FROM projects WHERE id=$1", [
        complete.projectId,
      ])
    ).rows[0].repo_path as string;
    const sha = (await git(repo, "rev-parse", "main")).trim();

    await database.pool.query(
      "UPDATE tasks SET qualification_mode='required',triage_status=NULL WHERE id=$1",
      [complete.taskId],
    );
    const input = await loadTaskQualificationInput(
      database.db,
      complete.projectId,
      complete.taskId,
    );
    const qualificationId = randomUUID();
    const assessment = {
      ...qualificationFixture(),
      decision,
      ...(decision === "needs_information"
        ? {
            reasonCodes: ["scope_unclear"],
            nextActions: ["Clarify the requested scope"],
          }
        : {}),
    };

    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO task_qualifications(id,project_id,task_id,revision,input_revision,input_digest,request_key,payload_digest,author_kind,author_identity,evidence_target,evidence_sha,value,routing,publication_state,published_at) VALUES (${qualificationId},${complete.projectId},${complete.taskId},1,${input.inputRevision},${input.inputDigest},${randomUUID()},${"a".repeat(64)},'project_token','verified-human-token','main',${sha},${JSON.stringify(assessment)}::jsonb,'{"flowId":null,"runnerId":null,"baseBranch":null,"enqueue":false}'::jsonb,'accepted',now())`,
      );
      await tx.execute(
        sql`UPDATE tasks SET current_qualification_id=${qualificationId},current_qualification_revision=1,qualification_revision_counter=1,triage_status=${decision === "ready" ? "triaged" : "flagged"},triage_flag_origin=${decision === "ready" ? null : "qualification"} WHERE id=${complete.taskId}`,
      );
    });
    expect(
      await getAgentRetryOptions(database.db, complete.runId, complete.userId),
    ).toMatchObject({ eligible: false, reason: "retry_qualification_current" });
    await writeFile(
      path.join(repo, "new-evidence.txt"),
      "Updated repository evidence",
    );
    await git(repo, "add", "new-evidence.txt");
    await git(repo, "commit", "-m", "Advance qualification target");
    expect(
      await getAgentRetryOptions(database.db, complete.runId, complete.userId),
    ).toMatchObject({ eligible: true, strategy: "fresh_qualification" });
  },
);

it.each(["absent", "captured"] as const)(
  "continues a version-one retry with %s request input without changing its bytes or digest",
  async (input) => {
    const snapshot =
      input === "captured"
        ? {
            version: 1 as const,
            scheduleId: randomUUID(),
            triggerAttemptId: randomUUID(),
            requestAtLaunch: "Original legacy retry request 😀",
          }
        : undefined;
    const source = await fixture("none", snapshot);
    const prepared = await prepareAgentRetry(
      database.db,
      source.runId,
      source.userId,
    );
    const recipe = await retryRecipeFor(database.db, prepared, source.runnerId);

    if (recipe.version !== 2)
      throw new Error("Expected current version-two recipe");
    const {
      version: _version,
      strategy: _strategy,
      qualificationSha: _sha,
      ...current
    } = recipe;
    const legacy = {
      ...current,
      version: 1 as const,
      contextDigest: prepared.legacyContextDigest,
    };
    const id = randomUUID();

    await database.db.insert(agentRetryIntents).values({
      id,
      projectId: source.projectId,
      sourceAgentId: recipe.agentId,
      sourceRunId: source.runId,
      actorIdentity: `user:${source.userId}`,
      actorUserId: source.userId,
      requestKey: randomUUID(),
      requestDigest: retryDigest({ id }),
      selectedRunnerId: source.runnerId,
      recipe: legacy,
      previewFingerprint: prepared.options.previewFingerprint,
      successorRunId: randomUUID(),
      dueAt: new Date(Date.now() - 1000),
    });
    const before = (
      await database.pool.query(
        "SELECT recipe::text AS recipe FROM agent_retry_intents WHERE id=$1",
        [id],
      )
    ).rows[0].recipe;

    expect(JSON.parse(before).version).toBe(1);
    if (!snapshot)
      expect(JSON.parse(before)).not.toHaveProperty("scheduledRequestSnapshot");
    await runAgentRetryAdmissionSweep(database.db);
    const receipt = await getAgentRetryReceipt(
      database.db,
      source.runId,
      id,
      source.userId,
    );

    expect(receipt).toMatchObject({
      intentState: "launched",
      runStatus: "Pending",
    });
    const after = (
      await database.pool.query(
        "SELECT recipe::text AS recipe FROM agent_retry_intents WHERE id=$1",
        [id],
      )
    ).rows[0].recipe;

    expect(after).toBe(before);
    expect(
      (
        await database.pool.query(
          "SELECT scheduled_request_snapshot FROM runs WHERE id=$1",
          [receipt.runId],
        )
      ).rows[0].scheduled_request_snapshot,
    ).toEqual(snapshot ?? null);
  },
);

it("IT-UX-14 accepts one immutable retry of a proven pre-work failure, converges replay and concurrent admission, and leaves a capacity-queued child visible", async () => {
  const snapshot = {
    version: 1 as const,
    scheduleId: randomUUID(),
    triggerAttemptId: randomUUID(),
    requestAtLaunch: "Original retry request: Отчёт 😀",
  };
  const fixtureData = await fixture("none", snapshot);
  const alternativeId = randomUUID();
  const alternative = testRunnerSnapshot(alternativeId, "codex");

  await database.db.insert(platformAcpRunners).values({
    id: alternativeId,
    adapter: "codex",
    capabilityAgent: "codex",
    model: alternative.model,
    provider: { kind: "openai" },
    permissionPolicy: "default",
    readinessStatus: "Ready",
    readinessReasons: [],
    enabled: true,
  });
  const options = await getAgentRetryOptions(
    database.db,
    fixtureData.runId,
    fixtureData.userId,
  );

  expect(options).toMatchObject({ eligible: true, reason: null });
  const request = {
    runnerId: alternativeId,
    requestKey: randomUUID(),
    previewFingerprint: options.previewFingerprint,
  };
  const first = await acceptAgentRetry(
    database.db,
    fixtureData.runId,
    fixtureData.userId,
    request,
  );

  expect(first).toMatchObject({ intentState: "accepted", runId: null });
  expect(
    await acceptAgentRetry(
      database.db,
      fixtureData.runId,
      fixtureData.userId,
      request,
    ),
  ).toEqual(first);
  await expect(
    acceptAgentRetry(database.db, fixtureData.runId, fixtureData.userId, {
      ...request,
      requestKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await Promise.all([
    runAgentRetryAdmissionSweep(database.db),
    runAgentRetryAdmissionSweep(database.db),
  ]);
  const receipt = await getAgentRetryReceipt(
    database.db,
    fixtureData.runId,
    first.retryIntentId,
    fixtureData.userId,
  );

  expect(receipt).toMatchObject({
    intentState: "launched",
    runStatus: "Pending",
  });
  const children = (
    await database.pool.query(
      "SELECT retry_of_run_id,trigger_source,trigger_event_id,agent_config,status,scheduled_request_snapshot FROM runs WHERE retry_of_run_id=$1",
      [fixtureData.runId],
    )
  ).rows;

  expect(children).toHaveLength(1);
  expect(children[0].scheduled_request_snapshot).toEqual(snapshot);
  const recipe = (
    await database.pool.query(
      "SELECT recipe FROM agent_retry_intents WHERE id=$1",
      [first.retryIntentId],
    )
  ).rows[0].recipe;

  expect(recipe).toMatchObject({
    version: 2,
    strategy: "pre_work_retry",
    scheduledRequestSnapshot: snapshot,
  });
  expect(children[0]).toMatchObject({
    retry_of_run_id: fixtureData.runId,
    trigger_source: "cron",
    trigger_event_id: null,
    status: "Pending",
  });
  expect(
    (
      await database.pool.query(
        "SELECT state,recipe FROM agent_retry_intents WHERE id=$1",
        [first.retryIntentId],
      )
    ).rows[0].recipe.runner.id,
  ).toBe(alternativeId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_id FROM run_sessions WHERE run_id=$1",
        [receipt.runId],
      )
    ).rows[0].runner_id,
  ).toBe(alternativeId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_id FROM run_sessions WHERE run_id=$1",
        [fixtureData.runId],
      )
    ).rows[0].runner_id,
  ).toBe(fixtureData.runnerId);
  expect(
    (
      await database.pool.query(
        "SELECT runner_override_id FROM agent_project_links WHERE project_id=$1",
        [fixtureData.projectId],
      )
    ).rows[0].runner_override_id,
  ).toBeNull();
});

it("IT-UX-15 refuses unknown work and stale previews, and revokes delayed execution when the accepting actor loses access", async () => {
  const source = await fixture();
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );

  await expect(
    acceptAgentRetry(database.db, source.runId, source.userId, {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: "0".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
    },
  );

  await database.pool.query("DELETE FROM project_members WHERE user_id=$1", [
    source.userId,
  ]);
  await runAgentRetryAdmissionSweep(database.db);
  expect(
    (
      await database.pool.query(
        "SELECT state,refusal_reason FROM agent_retry_intents WHERE id=$1",
        [receipt.retryIntentId],
      )
    ).rows[0],
  ).toEqual({ state: "refused", refusal_reason: "retry_authority_revoked" });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM runs WHERE retry_of_run_id=$1",
        [source.runId],
      )
    ).rows,
  ).toEqual([]);
  await database.pool.query(
    "INSERT INTO project_members(id,project_id,user_id,role) VALUES ($1,$2,$3,'member')",
    [randomUUID(), source.projectId, source.userId],
  );
  await database.pool.query(
    "UPDATE run_sessions SET acp_session_id='unresolved-source' WHERE run_id=$1",
    [source.runId],
  );
  expect(
    await getAgentRetryOptions(database.db, source.runId, source.userId),
  ).toMatchObject({ eligible: false, reason: "reconciliation_required" });
});

async function abandonedAllocation(
  source: Awaited<ReturnType<typeof fixture>>,
): Promise<{
  intentId: string;
  successorId: string;
  worktree: string;
  repo: string;
  claim: { intentId: string; owner: string; fence: number };
}> {
  const options = await getAgentRetryOptions(
    database.db,
    source.runId,
    source.userId,
  );
  const accepted = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    {
      runnerId: source.runnerId,
      requestKey: randomUUID(),
      previewFingerprint: options.previewFingerprint,
    },
  );
  const intent = (
    await database.pool.query(
      "UPDATE agent_retry_intents SET lease_owner='crash-fixture',lease_fence=lease_fence+1,lease_expires_at=now()+interval '5 minutes' WHERE id=$1 RETURNING *",
      [accepted.retryIntentId],
    )
  ).rows[0];
  const project = (
    await database.pool.query("SELECT * FROM projects WHERE id=$1", [
      source.projectId,
    ])
  ).rows[0];
  const run = (
    await database.pool.query("SELECT agent_id FROM runs WHERE id=$1", [
      source.runId,
    ])
  ).rows[0];
  const worktree = agentWorkdirPath(project.slug, intent.successor_run_id);
  const branch = agentWorktreeBranchName({
    prefix: project.branch_prefix,
    agentId: run.agent_id,
    runId: intent.successor_run_id,
  });
  const claim = {
    intentId: intent.id,
    owner: "crash-fixture",
    fence: intent.lease_fence,
  };

  await allocateAgentRetryWorktree(database.db, claim, {
    runId: intent.successor_run_id,
    projectId: source.projectId,
    repositoryPath: project.repo_path,
    path: worktree,
    branch,
    baseCommit: (await git(project.repo_path, "rev-parse", "main")).trim(),
  });
  await database.pool.query(
    "UPDATE agent_retry_intents SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [intent.id],
  );

  return {
    intentId: intent.id,
    successorId: intent.successor_run_id,
    worktree,
    repo: project.repo_path,
    claim,
  };
}

it("IT-UX-15 adopts only the exact preallocated worktree after a dead owner, fences stale insertion, and preserves foreign bytes through cleanup failure and explicit rearm", async () => {
  const clean = await fixture("worktree");
  const abandoned = await abandonedAllocation(clean);

  await runAgentRetryAdmissionSweep(database.db);
  expect(
    await getAgentRetryReceipt(
      database.db,
      clean.runId,
      abandoned.intentId,
      clean.userId,
    ),
  ).toMatchObject({
    intentState: "launched",
    runId: abandoned.successorId,
    runStatus: "Pending",
    cleanup: { state: "released" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int total FROM runs WHERE retry_of_run_id=$1",
        [clean.runId],
      )
    ).rows[0].total,
  ).toBe(1);
  await expect(
    allocateAgentRetryWorktree(database.db, abandoned.claim, {
      runId: abandoned.successorId,
      projectId: clean.projectId,
      repositoryPath: abandoned.repo,
      path: abandoned.worktree,
      branch: "foreign",
      baseCommit: "a".repeat(40),
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const dirty = await fixture("worktree");
  const interrupted = await abandonedAllocation(dirty);

  await writeFile(
    path.join(interrupted.worktree, "unexpected.txt"),
    "preserve this diagnosis",
  );
  const index = (
    await git(interrupted.worktree, "rev-parse", "--git-path", "index")
  ).trim();
  const lock = path.isAbsolute(index)
    ? `${index}.lock`
    : path.join(interrupted.worktree, `${index}.lock`);

  await writeFile(lock, "");
  await database.pool.query(
    "UPDATE agent_retry_intents SET allocation=jsonb_set(allocation,'{attempts}','4') WHERE id=$1",
    [interrupted.intentId],
  );
  await runAgentRetryAdmissionSweep(database.db);
  const refused = await getAgentRetryReceipt(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
  );

  expect(refused).toMatchObject({
    intentState: "refused",
    runId: null,
    cleanup: { state: "exhausted" },
  });
  expect(
    await readFile(path.join(interrupted.worktree, "unexpected.txt"), "utf8"),
  ).toBe("preserve this diagnosis");
  const request = {
    requestKey: randomUUID(),
    expectedDispositionRevision: refused.cleanup!.revision,
  };

  await expect(
    rearmAgentRetryCleanup(
      database.db,
      dirty.runId,
      interrupted.intentId,
      dirty.userId,
      { ...request, expectedDispositionRevision: 1 },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const rearmed = await rearmAgentRetryCleanup(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
    request,
  );

  expect(
    await rearmAgentRetryCleanup(
      database.db,
      dirty.runId,
      interrupted.intentId,
      dirty.userId,
      request,
    ),
  ).toEqual(rearmed);
  await rm(lock);
  await runAgentRetryAdmissionSweep(database.db);
  const settled = await getAgentRetryReceipt(
    database.db,
    dirty.runId,
    interrupted.intentId,
    dirty.userId,
  );

  expect(settled).toMatchObject({
    intentState: "refused",
    runId: null,
    cleanup: { state: "released" },
  });
  await expect(access(interrupted.worktree)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await git(
        interrupted.repo,
        "show",
        `maister/archive/${interrupted.successorId}:unexpected.txt`,
      )
    ).trim(),
  ).toBe("preserve this diagnosis");
  expect(
    (
      await database.pool.query(
        "SELECT id FROM runs WHERE retry_of_run_id=$1",
        [dirty.runId],
      )
    ).rows,
  ).toEqual([]);
});

it("IT-UX-14 enforces the actual retry HTTP boundary, excludes protected recipes and rejects untrusted body locators and revoked grants", async () => {
  const { GET } = await import("@/app/api/runs/[runId]/retry-options/route");
  const { POST } = await import("@/app/api/runs/[runId]/retry/route");
  const source = await fixture();
  const params = { params: Promise.resolve({ runId: source.runId }) };

  sessionUserId = source.userId;
  const optionsResponse = await GET(
    new Request("http://test/retry-options"),
    params,
  );
  const options = await optionsResponse.json();

  expect(optionsResponse.status).toBe(200);
  expect(options).toMatchObject({ eligible: true, existingIntentId: null });
  expect(JSON.stringify(options)).not.toMatch(
    /installedPath|sourcePath|permissionPolicy|authToken|apiKey/,
  );
  const request = {
    runnerId: source.runnerId,
    requestKey: randomUUID(),
    previewFingerprint: options.previewFingerprint,
  };

  expect(
    (
      await POST(
        new Request("http://test/retry", {
          method: "POST",
          body: JSON.stringify({ ...request, projectId: source.projectId }),
        }),
        params,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request("http://test/retry", { method: "POST", body: "{" }),
        params,
      )
    ).status,
  ).toBe(400);
  await database.pool.query(
    "UPDATE project_members SET role='viewer' WHERE user_id=$1",
    [source.userId],
  );
  expect(
    (await GET(new Request("http://test/retry-options"), params)).status,
  ).toBe(403);
  await database.pool.query(
    "UPDATE project_members SET role='member' WHERE user_id=$1",
    [source.userId],
  );
  const receipt = await acceptAgentRetry(
    database.db,
    source.runId,
    source.userId,
    request,
  );

  expect(
    await getAgentRetryOptions(database.db, source.runId, source.userId),
  ).toMatchObject({
    eligible: false,
    reason: "retry_successor_already_owned",
    existingIntentId: receipt.retryIntentId,
  });
  await database.pool.query(
    "UPDATE agent_project_links SET enabled=false WHERE project_id=$1",
    [source.projectId],
  );
  await runAgentRetryAdmissionSweep(database.db);
  expect(
    await getAgentRetryReceipt(
      database.db,
      source.runId,
      receipt.retryIntentId,
      source.userId,
    ),
  ).toMatchObject({ intentState: "refused", runId: null });
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int total FROM runs WHERE retry_of_run_id=$1",
        [source.runId],
      )
    ).rows[0].total,
  ).toBe(0);
});
