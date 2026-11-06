import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeExecutionHost,
  fakeExecutionHosts,
} from "@/test-support/fake-execution-host";
import { createExecutionHosts } from "@/lib/execution-host";
import { releaseAssignmentForRun } from "@/lib/execution-host/assignments";
import { runFlow } from "@/lib/flows/runner";
import { runReviewHuman } from "@/lib/flows/graph/runner-graph";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { compileManifest } from "@/lib/flows/graph/compile";
import { POST as abandonRun } from "@/app/api/runs/[runId]/abandon/route";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { tryStartRun } from "@/lib/scheduler";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git, initRepo } from "@/test-support/git-fixture";
import {
  invocationFromEnvironment,
  registerRoot,
} from "@/test-support/process-invocation";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let executionDb: ExecutionDb;

const session = vi.hoisted(() => ({ userId: "" }));
const traversalBarrier = vi.hoisted(() => ({
  runId: "",
  entered: (): void => {},
  released: Promise.resolve(),
}));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: session.userId } }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/flows/graph/ledger", async (original) => {
  const actual = await original<typeof import("@/lib/flows/graph/ledger")>();

  return {
    ...actual,
    getNodeAttemptsForRun: async (
      ...args: Parameters<typeof actual.getNodeAttemptsForRun>
    ) => {
      const rows = await actual.getNodeAttemptsForRun(...args);

      if (args[0] === traversalBarrier.runId) {
        traversalBarrier.runId = "";
        // The real SELECT has finished: no SQL lock is held across this barrier.
        traversalBarrier.entered();
        await traversalBarrier.released;
      }

      return rows;
    },
  };
});

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
  executionDb = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

async function seedGraphRun(
  manifest: unknown,
  opts: { executionPolicy?: ExecutionPolicy } = {},
): Promise<SeededGraphRun> {
  const seeded = await seedGraphRunShared(db, manifest, {
    run:
      opts.executionPolicy !== undefined
        ? { executionPolicy: opts.executionPolicy }
        : {},
  });

  await fakeExecutionHosts(db, { runId: seeded.runId });

  return seeded;
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

async function writeDecision(
  seeded: SeededGraphRun,
  nodeId: string,
  decision: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify({ decision, ...extra }),
    "utf8",
  );
}

const cliChain = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "a",
      type: "cli",
      action: { command: "echo a" },
      transitions: { success: "b" },
    },
    {
      id: "b",
      type: "cli",
      action: { command: "echo b" },
      transitions: { success: "done" },
    },
  ],
};

const slowCheckFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "slow",
      type: "check",
      action: { command: "sleep 5" },
      settings: { timeoutMs: 300 },
      transitions: { success: "done" },
    },
  ],
};

const reviewFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "work",
      type: "cli",
      action: { command: "echo work {{ review_comments ?? '' }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          decisions: ["approve", "rework"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "work" },
      rework: {
        allowedTargets: ["work"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
};

// maxLoops: 1 → initial + 1 rework allowed; 2nd rework must exhaust the limit.
const tightLoopFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "work",
      type: "cli",
      action: { command: "echo work {{ review_comments ?? '' }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: {
          decisions: ["approve", "rework"],
          commentsVar: "review_comments",
        },
      },
      transitions: { approve: "done", rework: "work" },
      rework: {
        allowedTargets: ["work"],
        workspacePolicies: ["keep"],
        maxLoops: 1,
        commentsVar: "review_comments",
      },
    },
  ],
};

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

const terminalizationReview: FlowYamlV1 = {
  schemaVersion: 1,
  name: "Terminalization review",
  nodes: [
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve"] } },
      transitions: { approve: "done" },
    },
  ],
};

async function acceptedSessionlessRun(
  root: string,
  manifest: FlowYamlV1,
): Promise<string> {
  const fixture = await seedTaskLaunchFixture(testDatabase, root);

  session.userId = fixture.userId;
  await testDatabase.db
    .update(schema.projects)
    .set({ taskKey: `R${fixture.projectId.slice(0, 12)}`.toUpperCase() })
    .where(eq(schema.projects.id, fixture.projectId));
  await testDatabase.db
    .update(schema.flowRevisions)
    .set({ manifest })
    .where(eq(schema.flowRevisions.flowRefId, fixture.flowId));
  await testDatabase.db
    .update(schema.flows)
    .set({ manifest })
    .where(eq(schema.flows.id, fixture.flowId));
  const taskId = randomUUID();

  await testDatabase.db.insert(schema.tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: 1,
    title: "No-model terminalization",
    prompt: "Wait for the authorized human decision",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const receipt = await acceptInteractiveTaskLaunch(
    testDatabase.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: await taskLaunchSettingsToken(
        testDatabase.db,
        taskId,
      ),
      autoPromote: false,
    },
    randomUUID(),
  );
  const bound = await prepareTaskLaunchIntent(
    testDatabase.db,
    receipt.intentId,
  );

  if (!bound.runId) throw new Error("Expected accepted no-model Run binding");
  expect(await tryStartRun(bound.runId, { db: testDatabase.db })).toMatchObject(
    {
      started: true,
    },
  );

  return bound.runId;
}

async function removeTerminalizationFixture(root: string): Promise<void> {
  const repo = join(root, "repo");

  for (const line of (await git(repo, "worktree", "list", "--porcelain")).split(
    "\n",
  )) {
    if (line.startsWith("worktree ") && line.slice(9) !== repo)
      await git(repo, "worktree", "remove", "--force", line.slice(9));
  }
  await rm(root, { recursive: true });
}

describe("R20 sessionless Flow terminalization", () => {
  it.each(["never_placed", "missing_pointer_with_history"] as const)(
    "a legacy form preserves the exact %s placement boundary without host calls",
    async (placement) => {
      const root = await mkdtempReal("flow-terminalization-unplaced-");
      const repoPath = await initRepo(join(root, "repo"));
      const installedPath = join(root, "flow");
      const fake = createFakeExecutionHost();
      const hosts = createExecutionHosts({
        db: testDatabase.db,
        transport: fake.transport,
      });
      let unusedRuntimeRoot: string | null = null;

      try {
        await mkdir(installedPath);
        await writeFile(
          join(installedPath, "intake.json"),
          JSON.stringify({
            schemaVersion: 1,
            fields: [
              { name: "environment", type: "string", label: "Environment" },
            ],
          }),
        );
        const seeded = await seedGraphRunShared(
          db,
          {
            schemaVersion: 1,
            name: "Never-placed legacy form",
            nodes: [
              {
                id: "intake",
                type: "form",
                settings: { form_schema: "./intake.json" },
                transitions: { success: "done" },
              },
            ],
          },
          {
            repoPath,
            installedPath,
            flowRevision: true,
            workspace: { worktreePath: repoPath },
          },
        );

        unusedRuntimeRoot = seeded.runtimeRoot;

        const invocation = invocationFromEnvironment();

        if (invocation)
          await registerRoot(invocation, seeded.runtimeRoot, "fixture");

        if (placement === "missing_pointer_with_history") {
          await fakeExecutionHosts(db, { fake, runId: seeded.runId });
          await executionDb.transaction(async (tx) => {
            await releaseAssignmentForRun(tx, seeded.runId, "checkpointed");
            // Simulate a missing legacy pointer; retained history must forbid the never-placed grant.
            await tx
              .update(schema.runs)
              .set({ executionAssignmentId: null })
              .where(eq(schema.runs.id, seeded.runId));
          });
        }
        const callsBefore = fake.calls.length;
        const driver = runFlow(seeded.runId, {
          db,
          runtimeRoot: root,
          executionHosts: hosts,
        });

        if (placement === "missing_pointer_with_history") {
          await expect(driver).rejects.toMatchObject({
            code: "PRECONDITION",
            details: { reason: "assignment_missing" },
          });
          expect(await getAttempts(seeded.runId)).toEqual([]);
          expect((await getRun(seeded.runId)).status).toBe("Running");
        } else {
          await driver;
          expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
          expect(await getAttempts(seeded.runId)).toMatchObject([
            { nodeId: "intake", status: "NeedsInput" },
          ]);
          await writeFile(
            join(
              root,
              ".maister",
              seeded.slug,
              "runs",
              seeded.runId,
              "input-intake.json",
            ),
            JSON.stringify({ environment: "staging" }),
          );
          await runFlow(seeded.runId, {
            db,
            runtimeRoot: root,
            executionHosts: hosts,
          });
          expect((await getRun(seeded.runId)).status).toBe("Review");
          expect(await getAttempts(seeded.runId)).toMatchObject([
            {
              nodeId: "intake",
              status: "Succeeded",
              vars: { environment: "staging" },
            },
          ]);
          expect(
            await testDatabase.db
              .select()
              .from(schema.executionAssignments)
              .where(eq(schema.executionAssignments.runId, seeded.runId)),
          ).toEqual([]);
        }
        expect(fake.calls.slice(callsBefore)).toEqual([]);
        expect(
          await testDatabase.db
            .select()
            .from(schema.executionCommands)
            .where(eq(schema.executionCommands.runId, seeded.runId)),
        ).toEqual([]);
      } finally {
        if (unusedRuntimeRoot) await rm(unusedRuntimeRoot, { recursive: true });
        await removeTerminalizationFixture(root);
      }
    },
    60_000,
  );

  it.each(["accepted", "legacy"] as const)(
    "a legal abandon fences an already-loaded %s human traversal before attempt/HITL publication",
    async (kind) => {
      const root = await mkdtempReal("flow-terminalization-");
      const originalRuntime = process.env.MAISTER_RUNTIME_ROOT;
      const entered = deferred();
      const released = deferred();
      let driver: Promise<void> | undefined;
      let legacy: SeededGraphRun | null = null;

      process.env.MAISTER_RUNTIME_ROOT = root;
      try {
        const { hosts } = await fakeExecutionHosts(db);
        const runId = await acceptedSessionlessRun(root, terminalizationReview);
        let target = runId;

        // Leave the accepted setup parked before exercising the separate live legacy Run.
        if (kind === "legacy") {
          await runFlow(runId, {
            db,
            runtimeRoot: root,
            executionHosts: hosts,
          });
          legacy = await seedGraphRun(terminalizationReview);
          const invocation = invocationFromEnvironment();

          if (invocation) {
            await registerRoot(invocation, legacy.worktreePath, "fixture");
            await registerRoot(invocation, legacy.runtimeRoot, "fixture");
          }
          target = legacy.runId;
        }
        traversalBarrier.runId = target;
        traversalBarrier.entered = entered.resolve;
        traversalBarrier.released = released.promise;
        driver = runFlow(target, { db, runtimeRoot: root });
        await Promise.race([
          entered.promise,
          driver.then(() => {
            throw new Error("Traversal ended before its pre-append barrier");
          }),
        ]);
        const response = await abandonRun(
          new NextRequest(`http://localhost/api/runs/${target}/abandon`, {
            method: "POST",
          }),
          { params: Promise.resolve({ runId: target }) },
        );

        expect(response.status).toBe(200);
        const terminal = await getRun(target);

        expect(terminal.status).toBe("Abandoned");
        released.resolve();
        await driver;
        const [current] = await testDatabase.db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.id, target));
        const hitls = await testDatabase.db
          .select()
          .from(schema.hitlRequests)
          .where(
            and(
              eq(schema.hitlRequests.runId, target),
              isNull(schema.hitlRequests.respondedAt),
            ),
          );
        const notifications = await testDatabase.db
          .select()
          .from(schema.domainEvents)
          .where(
            and(
              eq(schema.domainEvents.runId, target),
              eq(schema.domainEvents.kind, "run.needs_input"),
            ),
          );

        expect({
          status: current.status,
          endedAt: current.endedAt,
          attempts: (await getAttempts(target)).length,
          openHitls: hitls.length,
          notifications: notifications.length,
        }).toEqual({
          status: "Abandoned",
          endedAt: terminal.endedAt,
          attempts: 0,
          openHitls: 0,
          notifications: 0,
        });
      } finally {
        traversalBarrier.runId = "";
        released.resolve();
        await driver;
        session.userId = "";
        if (originalRuntime === undefined)
          delete process.env.MAISTER_RUNTIME_ROOT;
        else process.env.MAISTER_RUNTIME_ROOT = originalRuntime;
        if (legacy) {
          await rm(legacy.worktreePath, { recursive: true });
          await rm(legacy.runtimeRoot, { recursive: true });
        }
        await removeTerminalizationFixture(root);
      }
    },
    60_000,
  );

  it("a valid accepted form pauses without creating an ACP command or session", async () => {
    const root = await mkdtempReal("flow-terminalization-form-");
    const originalRuntime = process.env.MAISTER_RUNTIME_ROOT;

    process.env.MAISTER_RUNTIME_ROOT = root;
    try {
      const { hosts, fake } = await fakeExecutionHosts(db);

      await mkdir(join(root, "flow"), { recursive: true });
      await writeFile(
        join(root, "flow", "intake.json"),
        JSON.stringify({
          schemaVersion: 1,
          fields: [
            { name: "environment", type: "string", label: "Environment" },
          ],
        }),
      );
      const runId = await acceptedSessionlessRun(root, {
        schemaVersion: 1,
        name: "No-model form",
        nodes: [
          {
            id: "intake",
            type: "form",
            settings: { form_schema: "./intake.json" },
            transitions: { success: "done" },
          },
        ],
      });
      const callsBefore = fake.calls.length;

      await runFlow(runId, { db, runtimeRoot: root, executionHosts: hosts });
      expect((await getRun(runId)).status).toBe("NeedsInput");
      expect(await getAttempts(runId)).toMatchObject([
        { nodeId: "intake", status: "NeedsInput" },
      ]);
      expect(
        await testDatabase.db
          .select()
          .from(schema.executionCommands)
          .where(eq(schema.executionCommands.runId, runId)),
      ).toEqual([]);
      expect(fake.calls.slice(callsBefore)).toEqual([]);
    } finally {
      session.userId = "";
      if (originalRuntime === undefined)
        delete process.env.MAISTER_RUNTIME_ROOT;
      else process.env.MAISTER_RUNTIME_ROOT = originalRuntime;
      await removeTerminalizationFixture(root);
    }
  }, 60_000);
});

describe("runGraph — traversal + ledger", () => {
  it("walks a cli-node chain to Review writing append-only node_attempts", async () => {
    const seeded = await seedGraphRun(cliChain);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.nodeId === "a")?.status).toBe("Succeeded");
    expect(attempts.find((a) => a.nodeId === "b")?.status).toBe("Succeeded");
    expect(attempts.every((a) => a.attempt === 1)).toBe(true);
  });

  it("honors settings.timeoutMs on a check node — command killed, run Failed", async () => {
    const seeded = await seedGraphRun(slowCheckFlow);
    const startedAt = Date.now();

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect(Date.now() - startedAt).toBeLessThan(4_500);
    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "slow")?.status).toBe("Failed");
  });

  it("pauses at a human review node, then approve advances to Review", async () => {
    const seeded = await seedGraphRun(reviewFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    const hitl = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(hitl[0].kind).toBe("human");
    expect(
      (hitl[0].schema as { allowedDecisions: string[] }).allowedDecisions,
    ).toEqual(["approve", "rework"]);

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).toBe("Review");

    const review = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review",
    );

    expect(review?.status).toBe("Succeeded");
    expect(review?.decision).toBe("approve");
  });

  it("rework jumps back (review Reworked, work re-runs), then approve finishes", async () => {
    const seeded = await seedGraphRun(reviewFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework -> jump back to work, which re-runs; review re-pauses for a fresh
    // decision (the input artifact is consumed on read).
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    let run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    const afterRework = await getAttempts(seeded.runId);

    expect(
      afterRework.find((a) => a.nodeId === "review" && a.attempt === 1)?.status,
    ).toBe("Reworked");
    expect(afterRework.filter((a) => a.nodeId === "work")).toHaveLength(2); // re-ran
    expect(
      afterRework.find((a) => a.nodeId === "review" && a.attempt === 2)?.status,
    ).toBe("NeedsInput");

    // Approve the fresh review -> run reaches Review.
    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    run = await getRun(seeded.runId);
    expect(run.status).toBe("Review");
  });

  // A.2 (axis A1): rework on-exhaustion. tightLoopFlow has maxLoops: 1 — one
  // rework is allowed; the second rework decision overruns the bound. The
  // run's execution-policy reworkExhaustion action decides what happens then.
  it("rework exhausted with reworkExhaustion=fail → run Failed (A.2)", async () => {
    // Explicit `fail` — the pre-A.2 outcome, now policy-driven at the rework
    // decision site rather than the loop-top backstop.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "fail" },
      },
    });

    // Pass 1: work → review (NeedsInput, attempt 1).
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Rework 1 (allowed — within maxLoops: 1): review attempt 1 → Reworked,
    // work reruns, review attempt 2 → NeedsInput.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    const afterFirstRework = await getAttempts(seeded.runId);

    expect(afterFirstRework.filter((a) => a.nodeId === "review")).toHaveLength(
      2,
    );
    expect(
      afterFirstRework.find((a) => a.nodeId === "review" && a.attempt === 1)
        ?.status,
    ).toBe("Reworked");

    // Rework 2 (overruns maxLoops: 1) → fail action → run Failed.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");
  }, 60_000);

  it("rework exhausted with reworkExhaustion=escalate (default) → NeedsInput, no further loop (A.2)", async () => {
    // Default supervised policy → escalate: the overrunning rework re-pauses
    // the review for a human terminal decision instead of failing or looping.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: { preset: "supervised" },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Second (overrunning) rework → escalate → NeedsInput, NOT Failed.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const run = await getRun(seeded.runId);

    expect(run.status).toBe("NeedsInput");
    expect(run.currentStepId).toBe("review");

    // No jump-back happened: review stays at 2 attempts and work did not re-run
    // a third time — the loop is held, not advanced.
    const attempts = await getAttempts(seeded.runId);

    expect(attempts.filter((a) => a.nodeId === "review")).toHaveLength(2);
    expect(attempts.filter((a) => a.nodeId === "work")).toHaveLength(2);

    // A fresh escalation HITL request exists so a human is asked to resolve.
    const hitl = await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, seeded.runId));

    expect(hitl.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("rework exhausted with reworkExhaustion=ship_with_warning → ships forward to Review (A.2)", async () => {
    // ship_with_warning takes the node's forward (approve) transition past the
    // exhausted loop and records the warning on the attempt.
    const seeded = await seedGraphRun(tightLoopFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { reworkExhaustion: "ship_with_warning" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    // Second (overrunning) rework → ship_with_warning → forward to Review.
    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const review2 = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review" && a.attempt === 2,
    );

    expect(review2?.status).toBe("Succeeded");
    expect(review2?.decision).toBe("approve");
    expect(
      (review2?.vars as Record<string, unknown>)?.execPolicyWarning,
    ).toBeDefined();
  }, 60_000);

  it("injects the reviewer's comments into the rework target's context (commentsVar)", async () => {
    // `fix` is reached ONLY via rework, so its {{ review_comments }} template
    // is rendered exclusively with the injected value present.
    const commentsFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.1.0" },
      nodes: [
        {
          id: "plan",
          type: "cli",
          action: { command: "echo plan" },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              decisions: ["approve", "rework"],
              commentsVar: "review_comments",
            },
          },
          transitions: { approve: "done", rework: "fix" },
          rework: {
            allowedTargets: ["fix"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "review_comments",
          },
        },
        {
          id: "fix",
          type: "cli",
          action: { command: 'echo "rc:{{ review_comments }}"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(commentsFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    await writeDecision(seeded, "review", "rework", {
      comments: "tighten-errors",
    });
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const fix = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "fix",
    );

    expect(fix?.status).toBe("Succeeded");
    expect(fix?.stdout ?? "").toContain("rc:tighten-errors");
  }, 60_000);
});

// B2/B3: human-gate auto-pass + on-stuck routing. reviewFlow has a forward
// "approve" decision (safe default); noForwardFlow has only a rework decision,
// so auto-pass can never fire → the can't-auto-pass routing (onStuck) is
// exercised without an expensive evidence-not-ready fixture.
const noForwardFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "work",
      type: "cli",
      action: { command: "echo work {{ review_comments ?? '' }}" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: {
        human: { decisions: ["redo"], commentsVar: "review_comments" },
      },
      transitions: { redo: "work", approve: "done" },
      rework: {
        allowedTargets: ["work"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "review_comments",
      },
    },
  ],
};

async function hitlCount(runId: string): Promise<number> {
  return (
    await db
      .select()
      .from(schema.hitlRequests)
      .where(eq(schema.hitlRequests.runId, runId))
  ).length;
}

async function assignmentCount(runId: string): Promise<number> {
  return (
    await db
      .select()
      .from(schema.assignments)
      .where(eq(schema.assignments.runId, runId))
  ).length;
}

async function escalatedEventCount(runId: string): Promise<number> {
  const rows = (await db
    .select()
    .from(schema.domainEvents)
    .where(eq(schema.domainEvents.runId, runId))) as Array<{ kind: string }>;

  return rows.filter((e) => e.kind === "run.escalated").length;
}

describe("runGraph — B2/B3 human-gate auto-pass + on-stuck routing", () => {
  it("auto-passes a human gate with the forward decision when machine review is ready", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    // No blocking gates / required artifacts → evidence ready → auto-pass
    // resolves "approve" and the run reaches Review with NO HITL.
    expect((await getRun(seeded.runId)).status).toBe("Review");
    expect(await hitlCount(seeded.runId)).toBe(0);

    const review = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "review",
    );

    expect(review?.status).toBe("Succeeded");
    expect(review?.decision).toBe("approve");
  }, 60_000);

  it("supervised (humanGate=stop) still pauses for a human (regression)", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: { preset: "supervised" },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await escalatedEventCount(seeded.runId)).toBe(0);
  }, 60_000);

  it("auto_pass with no safe default → escalate: NeedsInput + assignment + run.escalated", async () => {
    const seeded = await seedGraphRun(noForwardFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBeGreaterThanOrEqual(1);
    expect(await escalatedEventCount(seeded.runId)).toBe(1);
  }, 60_000);

  it("auto_pass + onStuck=notify_only → NeedsInput WITHOUT an assignment + run.escalated", async () => {
    const seeded = await seedGraphRun(noForwardFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass", onStuck: "notify_only" },
      },
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");
    // The HITL request still exists (a response CAN resolve it) but no human
    // is assigned — notify-and-don't-block.
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBe(0);
    expect(await escalatedEventCount(seeded.runId)).toBe(1);
  }, 60_000);

  // F1 regression: the A.2 rework-exhaustion escalate path calls runReviewHuman
  // with forcePause=true and then flips the run to NeedsInput. Under an
  // unattended policy (humanGate=auto_pass) a plain call would auto-pass / ship
  // and create NO HITL row — orphaning the NeedsInput run (invisible to the
  // inbox, unresolvable). forcePause MUST skip the auto-pass/on-stuck
  // short-circuit and always create the HITL + assignment.
  it("forcePause forces a real HITL pause under humanGate=auto_pass (escalate never orphans)", async () => {
    const seeded = await seedGraphRun(reviewFlow, {
      executionPolicy: {
        preset: "supervised",
        overrides: { humanGate: "auto_pass" },
      },
    });
    const loaded = await loadRun(db, seeded.runId);
    const node = compileManifest(reviewFlow as unknown as FlowYamlV1).nodes.get(
      "review",
    );

    expect(node).toBeDefined();

    // Control: WITHOUT forcePause, auto_pass + ready evidence (no attempts → no
    // blocking gates) + safe default "approve" → auto-passes, creating NO HITL.
    const autoPassed = await runReviewHuman(node!, loaded, "review", {
      runtimeRoot: seeded.runtimeRoot,
      db,
      gateAttempt: 1,
    });

    expect(autoPassed.needsInput).toBe(false);
    expect(autoPassed.decision).toBe("approve");
    expect(await hitlCount(seeded.runId)).toBe(0);

    // Fix: WITH forcePause, the same call creates a real HITL request +
    // assignment, so the caller's NeedsInput flip can never orphan the run.
    const paused = await runReviewHuman(node!, loaded, "rework limit reached", {
      runtimeRoot: seeded.runtimeRoot,
      db,
      gateAttempt: 2,
      forcePause: true,
    });

    expect(paused.needsInput).toBe(true);
    expect(await hitlCount(seeded.runId)).toBe(1);
    expect(await assignmentCount(seeded.runId)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
