import type { FakeExecutionHost } from "@/test-support/fake-execution-host";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { POST as previewLaunch } from "@/app/api/runs/launch-options/route";
import {
  flows,
  flowRevisions,
  flowRunnerRemaps,
  platformAcpRunners,
  runSessions,
  tasks,
  runs,
} from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { resolveConsensusRoleRuntime } from "@/lib/flows/graph/consensus/roles";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { tryStartRun } from "@/lib/scheduler";
import {
  appendNodeAttempt,
  markNodeRunning,
  markNodeNeedsInput,
} from "@/lib/flows/graph/ledger";
import { markWaitingOnChildren } from "@/lib/runs/state-transitions";
import { abandonRunInTransaction } from "@/lib/runs/state-transitions";
import {
  claimFlowDriver,
  releaseFlowDriverClaim,
  isFlowDriverClaimLost,
} from "@/lib/flows/graph/driver-claim";
import { flowDriverDatabase } from "@/lib/flows/graph/driver-db";
import { poll } from "@/test-support/durable-workers-ledger";
import { launchConsensusDraftRuns } from "@/lib/flows/graph/consensus/drafts";
import {
  assertConsensusDraftAdmission,
  prepareConsensusDraftAdmission,
} from "@/lib/flows/graph/consensus/admission";
import { taskLaunchInputForRun } from "@/lib/tasks/launch-execution-input";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";
import * as databaseSchema from "@/lib/db/schema";
import { admitAgentGenerationTurn } from "@/lib/agents/generation-turn";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { issueOwnedPrompt } from "@/lib/execution-host/ledger";
import { claimDelivering } from "@/lib/execution-host/commands";
import { admitConsensusDraftPrompt } from "@/lib/flows/graph/consensus/draft-prompt-owner";

let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let fake: FakeExecutionHost;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "consensus_parent_admission",
  });
  root = await mkdtempReal("consensus-parent-admission-");
  fixture = await seedTaskLaunchFixture(database, root);
  ({ fake } = await fakeExecutionHosts(database.db));
  vi.stubEnv("MAISTER_MAX_CONCURRENT_AGENTS", "1");
  const installed = path.join(root, "agents");

  await mkdir(path.join(installed, "maister-agents"), { recursive: true });
  const source = path.join(installed, "maister-agents", "writer.md");

  await writeFile(
    source,
    "---\nname: Writer\ndescription: owned consensus participant\nkind: code_delivery\nworkspace: repo_read\nmode: session\ntriggers: [flow]\nrisk_tier: read_only\nplatform_mcp: false\n---\nReview the exact parent request.\n",
  );
  const packageId = randomUUID();

  await database.pool.query(
    "INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status) VALUES($1,'local','consensus-fixture','v1','consensus-revision','{}','digest',$2,'Installed','trusted')",
    [packageId, installed],
  );
  await database.pool.query(
    "INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name) VALUES($1,$2,$3,'consensus-fixture')",
    [randomUUID(), fixture.projectId, packageId],
  );
  await database.pool.query(
    "INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path,enabled) VALUES('consensus-fixture:writer','consensus-fixture','v1','authored','Writer','owned consensus participant','repo_read','session','[\"flow\"]','read_only',$1,true)",
    [source],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,agent_id,project_id,runner_override_id) VALUES($1,'consensus-fixture:writer',$2,$3)",
    [randomUUID(), fixture.projectId, fixture.runnerId],
  );
  await database.db
    .update(flowRevisions)
    .set({ resolvedRevision: "consensus-revision" });
}, 180_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await database?.stop();
  if (fixture) {
    for (const line of (
      await git(fixture.repo, "worktree", "list", "--porcelain")
    ).split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== fixture.repo)
        await git(fixture.repo, "worktree", "remove", "--force", line.slice(9));
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  for (const run of await database.db.select().from(runs)) {
    if (
      ["Running", "Pending", "WaitingOnChildren", "NeedsInput"].includes(
        run.status,
      )
    )
      await database.db.transaction((tx: Db) =>
        abandonRunInTransaction(tx, run.id, {
          code: null,
          reason: "owned_fixture_cleanup",
          source: "operator",
        }),
      );
  }
});

async function runningConsensusParent(oneRunRunnerId?: string) {
  const taskId = randomUUID();
  const [flow] = await database.db
    .select()
    .from(flows)
    .where(eq(flows.id, fixture.flowId));
  const directory = path.join(root, `consensus-flow-${taskId}`);

  await mkdir(directory);
  const participants = [
    { id: "architect", runner: fixture.runnerId },
    { id: "qa", runner: fixture.runnerId },
  ];
  const manifest = {
    schemaVersion: 1,
    name: "Owned consensus parent",
    compat: { engine_min: "3.6.0" },
    nodes: [
      {
        id: "decide",
        type: "consensus",
        prompt: "Review the bounded current task.",
        participants: [
          ...participants,
          { id: "writer", agent: "consensus-fixture:writer" },
        ],
        workspace: { mode: "repo_read" },
        material_axes: ["scope"],
        rounds: { mode: "single_pass", max: 1 },
        on_no_consensus: "escalate",
        synthesizer: { runner: fixture.runnerId },
        output: {
          produces: [
            { id: "consensus_plan", kind: "plan", current: true },
            { id: "debate_log", kind: "human_note", current: true },
          ],
        },
        transitions: { success: "done", agreement: "done" },
      },
    ],
  };

  await database.db
    .update(flows)
    .set({ manifest, installedPath: directory })
    .where(eq(flows.id, fixture.flowId));
  await database.db
    .update(flowRevisions)
    .set({ manifest, installedPath: directory })
    .where(eq(flowRevisions.id, flow.enabledRevisionId!));
  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Manual consensus",
    prompt: "Do the bounded fixture work",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const flowRunnerDraft = oneRunRunnerId
    ? {
        flowRevisionId: flow.enabledRevisionId!,
        slots: {
          "consensus:decide:architect": oneRunRunnerId,
          "consensus:decide:synthesizer": oneRunRunnerId,
        },
      }
    : undefined;
  let expectedSettingsToken: string;

  if (flowRunnerDraft) {
    const response = await previewLaunch(
      new NextRequest("http://localhost/api/runs/launch-options", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ taskId, flowRunnerDraft }),
      }),
    );

    expect(response.status).toBe(200);
    const result = await response.json();

    expect(result.options.runnerSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slotKey: "consensus:decide:architect",
          runnerId: oneRunRunnerId,
        }),
        expect.objectContaining({
          slotKey: "consensus:decide:synthesizer",
          runnerId: oneRunRunnerId,
        }),
      ]),
    );
    expectedSettingsToken = result.options.settingsToken;
  } else {
    expectedSettingsToken = await taskLaunchSettingsToken(database.db, taskId);
  }
  const accepted = await acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken,
      ...(flowRunnerDraft ? { flowRunnerDraft } : {}),
      autoPromote: false,
    },
    randomUUID(),
  );
  const bound = await prepareTaskLaunchIntent(database.db, accepted.intentId);

  expect(bound.runId).toEqual(expect.any(String));
  const parentRunId = bound.runId!;

  expect(await tryStartRun(parentRunId, { db: database.db })).toMatchObject({
    started: true,
  });
  await database.db
    .update(runs)
    .set({ currentStepId: "decide" })
    .where(eq(runs.id, parentRunId));
  const node = await appendNodeAttempt({
    runId: parentRunId,
    nodeId: "decide",
    nodeType: "consensus",
    db: database.db,
  });

  await markNodeRunning(node.id, database.db);

  return { taskId, parentRunId, node, flow, participants };
}

it("consensus roles and real drafts retain the accepted runner after a binding changes and fail closed when that runner changes", async () => {
  const oneRunRunnerId = randomUUID();

  await database.db
    .insert(platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        oneRunRunnerId,
        "codex",
      ) as typeof platformAcpRunners.$inferInsert,
    );
  const { taskId, parentRunId, node, flow, participants } =
    await runningConsensusParent(oneRunRunnerId);
  const bindingIds = [randomUUID(), randomUUID()];

  for (const [index, roleId] of ["architect", "synthesizer"].entries())
    await database.db.insert(flowRunnerRemaps).values({
      id: bindingIds[index],
      projectId: fixture.projectId,
      flowRevisionId: flow.enabledRevisionId!,
      slotKey: `consensus:decide:${roleId}`,
      mappedRunnerId: fixture.runnerId,
      status: "Mapped",
    });
  const roleContext = {
    db: database.db,
    parentRunId,
    projectId: fixture.projectId,
    taskId,
    flowRevisionId: flow.enabledRevisionId,
    runDefaultRunnerId: fixture.runnerId,
    runnerProfiles: undefined,
    slotKey: "consensus:decide:synthesizer",
    role: { runner: fixture.runnerId },
    roleLabel: "consensus synthesizer",
  };

  try {
    const runtime = await resolveConsensusRoleRuntime(roleContext);

    expect(runtime.resolution.runnerId).toBe(oneRunRunnerId);
    await expect(
      resolveConsensusRoleRuntime({
        ...roleContext,
        slotKey: "consensus:decide:missing-frozen-role",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "launch_runner_snapshot_incomplete" },
    });
    const result = await launchConsensusDraftRuns(
      {
        ...roleContext,
        rootDb: database.db,
        rootRunId: parentRunId,
        nodeId: "decide",
        nodeAttemptId: node.id,
        round: 1,
        participants: [participants[0]],
        prompts: [
          { participantId: "architect", prompt: "Review the frozen selection" },
        ],
        workspaceMode: "repo_read",
      },
      { startAgentSession: async () => undefined },
    );
    const [session] = await database.db
      .select()
      .from(runSessions)
      .where(eq(runSessions.runId, result[0].runId));

    expect(session.runnerId).toBe(oneRunRunnerId);
    expect(
      (
        await resolveConsensusRoleRuntime({
          ...roleContext,
          parentRunId: result[0].runId,
        })
      ).resolution.runnerId,
    ).toBe(oneRunRunnerId);
    await database.db
      .update(platformAcpRunners)
      .set({ enabled: false })
      .where(eq(platformAcpRunners.id, oneRunRunnerId));
    await expect(
      resolveConsensusRoleRuntime(roleContext),
    ).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "launch_runner_disabled" },
    });
    await database.db
      .update(platformAcpRunners)
      .set({ enabled: true, model: "changed-after-acceptance" })
      .where(eq(platformAcpRunners.id, oneRunRunnerId));
    await expect(
      resolveConsensusRoleRuntime(roleContext),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "launch_runner_changed" },
    });
  } finally {
    await database.db
      .update(platformAcpRunners)
      .set({ enabled: true, model: "gpt-5-codex" })
      .where(eq(platformAcpRunners.id, oneRunRunnerId));
    for (const id of bindingIds)
      await database.db
        .delete(flowRunnerRemaps)
        .where(eq(flowRunnerRemaps.id, id));
  }
});

it("a manually admitted unqualified parent can create its same-task consensus draft under parent-node authority", async () => {
  const { taskId, parentRunId, node, flow, participants } =
    await runningConsensusParent();

  await database.db
    .update(tasks)
    .set({ prompt: "A later task description must not replace parent input" })
    .where(eq(tasks.id, taskId));

  const result = await launchConsensusDraftRuns(
    {
      db: database.db,
      rootDb: database.db,
      projectId: fixture.projectId,
      taskId,
      flowRevisionId: flow.enabledRevisionId,
      runDefaultRunnerId: fixture.runnerId,
      runnerProfiles: undefined,
      parentRunId,
      rootRunId: parentRunId,
      nodeId: "decide",
      nodeAttemptId: node.id,
      round: 1,
      participants: [participants[0]],
      prompts: [
        { participantId: "architect", prompt: "Review the bounded fixture" },
      ],
      workspaceMode: "repo_read",
    },
    { startAgentSession: async () => undefined },
  );

  expect(result).toEqual([
    {
      participantId: "architect",
      participantKind: "runner",
      runId: expect.any(String),
      status: expect.stringMatching(/^(Running|Pending)$/),
    },
  ]);
  const [child] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, result[0].runId));

  expect(child).toMatchObject({ parentRunId, rootRunId: parentRunId, taskId });
  expect(child.taskAdmissionSnapshot).toMatchObject({
    version: 3,
    basis: "execution_child",
    scope: "consensus_draft",
    parent: {
      parentRunId,
      nodeAttemptId: node.id,
      participantId: "architect",
      participantKind: "runner",
      runnerId: fixture.runnerId,
    },
  });
  expect(await taskLaunchInputForRun(database.db, child)).toMatchObject({
    prompt: "Do the bounded fixture work",
  });
  if (child.taskAdmissionSnapshot?.version !== 3)
    throw new Error("Expected parent-derived fixture admission");
  await expect(
    assertConsensusDraftAdmission(
      database.db,
      child.taskAdmissionSnapshot,
      child,
    ),
  ).resolves.toBeUndefined();
  await expect(
    prepareConsensusDraftAdmission(database.db, {
      parentRunId,
      rootRunId: parentRunId,
      taskId,
      projectId: fixture.projectId,
      nodeId: "decide",
      nodeAttemptId: node.id,
      round: 3,
      participantId: "architect",
      participantKind: "runner",
      runnerId: fixture.runnerId,
      agentId: null,
      prompt: "Review the bounded fixture",
    }),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "consensus_parent_round_changed" },
  });
  const agentDrafts = await launchConsensusDraftRuns({
    db: database.db,
    rootDb: database.db,
    projectId: fixture.projectId,
    taskId,
    flowRevisionId: flow.enabledRevisionId,
    runDefaultRunnerId: fixture.runnerId,
    runnerProfiles: undefined,
    parentRunId,
    rootRunId: parentRunId,
    nodeId: "decide",
    nodeAttemptId: node.id,
    round: 1,
    participants: [{ id: "writer", agent: "consensus-fixture:writer" }],
    prompts: [
      { participantId: "writer", prompt: "Review the exact admitted fixture" },
    ],
    workspaceMode: "repo_read",
  });

  expect(agentDrafts).toEqual([
    {
      participantId: "writer",
      participantKind: "agent",
      runId: expect.any(String),
      status: "Pending",
    },
  ]);
  const [agentChild] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, agentDrafts[0].runId));

  expect(agentChild.taskAdmissionSnapshot).toMatchObject({
    version: 3,
    scope: "consensus_draft",
    parent: {
      parentRunId,
      participantId: "writer",
      participantKind: "agent",
      agentId: "consensus-fixture:writer",
    },
  });
  expect(await taskLaunchInputForRun(database.db, agentChild)).toMatchObject({
    prompt: "Do the bounded fixture work",
  });
  await markNodeNeedsInput(node.id, database.db);
  expect(
    await markWaitingOnChildren(parentRunId, { db: database.db }),
  ).toMatchObject({ ok: true });
  await expect(
    assertConsensusDraftAdmission(
      database.db,
      child.taskAdmissionSnapshot,
      child,
    ),
  ).resolves.toBeUndefined();
  expect(
    (
      await database.pool.query(
        "SELECT id FROM execution_commands WHERE run_id=ANY($1::text[])",
        [[child.id, agentChild.id]],
      )
    ).rows,
  ).toEqual([]);
  const freshManual = async () => {
    const [current] = await database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));

    return acceptInteractiveTaskLaunch(
      database.db,
      await interactiveTaskLaunchPrincipal(),
      {
        taskId,
        expectedTaskRevision: current.revision,
        expectedSettingsToken: await taskLaunchSettingsToken(
          database.db,
          taskId,
        ),
        autoPromote: false,
      },
      randomUUID(),
    );
  };

  await expect(freshManual()).rejects.toMatchObject({ code: "CONFLICT" });
  await database.db
    .update(runs)
    .set({ status: "Failed", endedAt: new Date() })
    .where(eq(runs.id, parentRunId));
  await expect(
    assertConsensusDraftAdmission(
      database.db,
      child.taskAdmissionSnapshot,
      child,
    ),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "consensus_parent_unavailable" },
  });
  expect(await freshManual()).toMatchObject({
    state: "queued",
    runId: null,
    basis: "manual",
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM task_qualifications WHERE task_id=$1",
        [taskId],
      )
    ).rows,
  ).toEqual([]);
});

it("an agent child completes dispatch on its independent database after its actual parent traversal parks", async () => {
  const { taskId, parentRunId, node, flow } = await runningConsensusParent();
  const [parent] = await database.db
    .select()
    .from(runs)
    .where(eq(runs.id, parentRunId));

  if (!parent.executionAssignmentId)
    throw new Error("Expected live parent placement");
  const claim = await claimFlowDriver(database.db, {
    runId: parentRunId,
    assignmentId: parent.executionAssignmentId,
  });

  if (!claim) throw new Error("Expected live parent traversal claim");
  const scoped = flowDriverDatabase(database.db, claim);
  const release = Promise.withResolvers<void>();
  let enteredRunId: string | null = null;
  const stop = fake.onCall("createSession", async (call) => {
    enteredRunId = call.envelope?.fence.runId ?? null;
    await release.promise;
  });

  fake.setPromptBehavior(async () => ({ stopReason: "end_turn", meta: null }));
  try {
    const drafts = await launchConsensusDraftRuns({
      db: scoped,
      rootDb: database.db,
      projectId: fixture.projectId,
      taskId,
      flowRevisionId: flow.enabledRevisionId,
      runDefaultRunnerId: fixture.runnerId,
      runnerProfiles: undefined,
      parentRunId,
      rootRunId: parentRunId,
      nodeId: "decide",
      nodeAttemptId: node.id,
      round: 1,
      participants: [{ id: "writer", agent: "consensus-fixture:writer" }],
      prompts: [
        {
          participantId: "writer",
          prompt: "Produce the bounded draft after parent park",
        },
      ],
      workspaceMode: "repo_read",
    });
    const childRunId = drafts[0].runId;

    expect(drafts[0]).toMatchObject({
      participantKind: "agent",
      status: "Running",
    });
    expect(
      await poll(
        async () => enteredRunId,
        10_000,
        "owned child create-session barrier",
        25,
      ),
    ).toBe(childRunId);
    await markNodeNeedsInput(node.id, database.db);
    expect(
      await markWaitingOnChildren(parentRunId, { db: database.db }),
    ).toMatchObject({ ok: true });
    await releaseFlowDriverClaim(database.db, claim);
    const fenced = await scoped
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, parentRunId))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(isFlowDriverClaimLost(fenced)).toBe(true);
    release.resolve();
    const command = await poll(
      async () => {
        const rows = await database.pool.query(
          "SELECT state,application_state FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
          [childRunId],
        );

        return (
          rows.rows.find((row) => row.application_state === "applied") ?? null
        );
      },
      10_000,
      "child prompt applied after parent traversal fencing",
      25,
    );

    expect(command).toMatchObject({
      state: "succeeded",
      application_state: "applied",
    });
    await poll(
      async () => {
        const [child] = await database.db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, childRunId));

        return child &&
          ["Done", "Failed", "Crashed", "Review"].includes(child.status)
          ? child
          : null;
      },
      10_000,
      "owned child terminal cleanup before fixture release",
      25,
    );
  } finally {
    release.resolve();
    stop();
    await releaseFlowDriverClaim(database.db, claim);
  }
});

it("serializes actual consensus prompt delivery with its idempotent replay without reversing parent and command locks", async () => {
  const { taskId, parentRunId, node, flow, participants } =
    await runningConsensusParent();
  const [draft] = await launchConsensusDraftRuns(
    {
      db: database.db,
      rootDb: database.db,
      parentRunId,
      rootRunId: parentRunId,
      projectId: fixture.projectId,
      taskId,
      flowRevisionId: flow.enabledRevisionId,
      runDefaultRunnerId: fixture.runnerId,
      runnerProfiles: undefined,
      nodeId: "decide",
      nodeAttemptId: node.id,
      round: 1,
      participants: [participants[0]],
      prompts: [
        { participantId: "architect", prompt: "Review the lock order" },
      ],
      workspaceMode: "repo_read",
    },
    { startAgentSession: async () => undefined },
  );
  const client = await createExecutionHosts({ db: database.db }).forRun(
    draft.runId,
  );
  const turn = await database.db.transaction((tx: Db) =>
    admitAgentGenerationTurn(tx, {
      runId: draft.runId,
      assignmentId: client.assignment.id,
      variant: "consensus_draft",
      prompt: "Review the lock order",
    }),
  );
  const session = await client.createOwnedSession(
    { variant: "agent", turnId: turn.id, promptOrdinal: turn.ordinal },
    async () => ({
      stepId: "agent",
      executor: { agent: "codex", model: "gpt-5-codex" },
      readOnlySession: true,
    }),
  );
  const request = {
    assignment: client.assignment,
    host: client.host,
    targetSessionId: session.sessionId,
    payload: { stepId: "agent", prompt: turn.prompt },
    maxAttempts: 3,
    admitOwner: (tx: Db) =>
      admitConsensusDraftPrompt(tx, client, session.sessionId, turn.id),
  };
  const original = await issueOwnedPrompt(database.db, request);
  const replayConnection = await database.pool.connect();
  const deliveryConnection = await database.pool.connect();
  let parentLocked = false;
  const replayAllowed = Promise.withResolvers<void>();
  const replayDb = drizzle(replayConnection, { schema: databaseSchema });
  const deliveryDb = drizzle(deliveryConnection, { schema: databaseSchema });
  const [{ pid: replayPid }] = (
    await replayConnection.query<{ pid: number }>("SELECT pg_backend_pid() pid")
  ).rows;
  const [{ pid: deliveryPid }] = (
    await deliveryConnection.query<{ pid: number }>(
      "SELECT pg_backend_pid() pid",
    )
  ).rows;

  await replayConnection.query("SET statement_timeout='10s'");
  await deliveryConnection.query("SET statement_timeout='10s'");
  const replay = replayDb
    .transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM runs WHERE id=${parentRunId} FOR UPDATE`,
      );
      parentLocked = true;
      await replayAllowed.promise;

      return issueOwnedPrompt(tx, request);
    })
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
  let delivery: Promise<
    | {
        status: "fulfilled";
        value: Awaited<ReturnType<typeof claimDelivering>>;
      }
    | { status: "rejected"; reason: unknown }
  > | null = null;

  try {
    await poll(
      async () => (parentLocked ? true : null),
      5_000,
      "consensus parent locked before competing command delivery",
      25,
    );
    delivery = claimDelivering(deliveryDb, original.row.id, 0).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    await poll(
      async () => {
        const { rows } = await database.pool.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) blocked",
          [replayPid, deliveryPid],
        );

        return rows[0]?.blocked ? true : null;
      },
      5_000,
      "actual command delivery blocked by the consensus parent owner",
      25,
    );
    // Both implementations reach this durable barrier. A command-first
    // deliverer now deadlocks against replay; a parent-first one leaves replay
    // free to read the command and commit before delivery acquires it.
    replayAllowed.resolve();
    const [replayed, delivered] = await Promise.all([replay, delivery]);

    if (replayed.status === "rejected") throw replayed.reason;
    if (delivered.status === "rejected") throw delivered.reason;
    expect(replayed).toMatchObject({
      status: "fulfilled",
      value: { row: { id: original.row.id } },
    });
    expect(delivered).toMatchObject({
      status: "fulfilled",
      value: {
        changed: true,
        row: { id: original.row.id, state: "delivering", attempts: 1 },
      },
    });
    const { rows } = await database.pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM execution_commands WHERE run_id=$1 AND kind='session.prompt'",
      [draft.runId],
    );

    expect(rows[0].count).toBe(1);
  } finally {
    replayAllowed.resolve();
    await Promise.all([replay, ...(delivery ? [delivery] : [])]);
    replayConnection.release(true);
    deliveryConnection.release(true);
    await client.deleteSession(session.sessionId);
  }
}, 30_000);
