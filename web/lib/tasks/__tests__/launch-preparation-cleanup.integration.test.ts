import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchFlowClaim } from "@/lib/tasks/launch-dispatch-claim";

import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  tasks,
  taskLaunchIntents,
  runs,
  workspaceReconciliationFindings,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import {
  assertTaskLaunchFlowClaim,
  claimTaskLaunchIntent,
  advanceTaskLaunchPreparation,
} from "@/lib/tasks/launch-dispatch-claim";
import {
  cleanupTaskLaunchPreparation,
  sweepTaskLaunchPreparationCleanup,
} from "@/lib/tasks/launch-preparation-cleanup";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import { launchAcceptedTaskRun } from "@/lib/services/runs";
import { runWorkspaceReconciliationSweep } from "@/lib/gc/workspace-reconciler";
import * as ownership from "@/lib/tasks/launch-preparation-ownership";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import { addWorktree, localBranchHead } from "@/lib/worktree";
import {
  seedTaskLaunchFixture,
  type TaskLaunchFixture,
} from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { git } from "@/test-support/git-fixture";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let db: Db;
let root: string;
let fixture: TaskLaunchFixture;
let sequence = 0;
let hostFixture: Awaited<ReturnType<typeof fakeExecutionHosts>>;
const priorRoot = process.env.MAISTER_WORKTREES_ROOT;
const priorRuntime = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "launch_preparation_cleanup",
  });
  db = database.db;
  root = await mkdtempReal("launch-preparation-cleanup-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = path.join(root, "manager");
  await mkdir(path.join(root, "manager"), { recursive: true });
  fixture = await seedTaskLaunchFixture(database, root);
  hostFixture = await fakeExecutionHosts(db);
}, 180_000);

afterAll(async () => {
  if (priorRoot === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorRoot;
  if (priorRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = priorRuntime;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function allocated(): Promise<TaskLaunchFlowClaim> {
  const taskId = randomUUID();

  await db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Prepare delivery",
    prompt: "Implement exact input",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const principal = await interactiveTaskLaunchPrincipal();
  const intent = await acceptInteractiveTaskLaunch(
    db,
    principal,
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: await taskLaunchSettingsToken(db, taskId),
      autoPromote: false,
    },
    randomUUID(),
  );
  const claim = await claimTaskLaunchIntent(db, intent.intentId);

  if (!claim) throw new Error("Fixture did not acquire its preparation");
  assertTaskLaunchFlowClaim(claim);

  return claim;
}

async function checkout(claim: TaskLaunchFlowClaim): Promise<void> {
  const identity = claim.identity;
  const fence = await acquireRepositoryMutationFence(identity.parentRepoPath);

  try {
    await fence.run(async () => {
      await addWorktree({
        projectRepoPath: identity.parentRepoPath,
        worktreePath: identity.worktreePath,
        branch: identity.branch,
        startPoint: identity.baseCommit,
        provenance: {
          version: 2,
          runId: identity.runId,
          parentRepoPath: identity.parentRepoPath,
          projectId: fixture.projectId,
          branch: identity.branch,
          workspaceKind: "flow",
          createdAt: new Date(0).toISOString(),
        },
      });
      await advanceTaskLaunchPreparation(db, claim, "checkout_ready");
    });
  } finally {
    await fence.release();
  }
}

async function cancel(claim: TaskLaunchFlowClaim): Promise<void> {
  const principal = await interactiveTaskLaunchPrincipal();
  const [current] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  await cancelInteractiveTaskLaunch(
    db,
    principal,
    claim.intentId,
    { expectedStateVersion: current.stateVersion },
    randomUUID(),
  );
}

async function prepared(): Promise<TaskLaunchFlowClaim> {
  const claim = await allocated();

  await checkout(claim);
  await cancel(claim);

  return claim;
}

it("removes only the pristine unbound cancelled preparation and records idempotent removal", async () => {
  const claim = await prepared();

  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
    "removed",
  );
  await expect(access(claim.identity.worktreePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    await localBranchHead({
      projectRepoPath: fixture.repo,
      branch: claim.identity.branch,
    }),
  ).toBeNull();
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  expect(intent.cleanupState).toBe("removed");
  expect(intent.attempts).toBe(0);
  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
    "removed",
  );
  await expect(
    advanceTaskLaunchPreparation(db, claim, "materializing"),
  ).rejects.toMatchObject({ details: { reason: "launch_worker_fenced" } });
});

it("a physical preparation owner defers cleanup without spending failure budget", async () => {
  const claim = await prepared();
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe("busy");
    await access(claim.identity.worktreePath);
  } finally {
    await fence.release();
  }
  const [intent] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  expect(intent.attempts).toBe(0);
  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
    "removed",
  );
});

it("retains modified and ignored bytes instead of treating Git's ignored metadata as pristine", async () => {
  const claim = await prepared();

  await writeFile(
    path.join(claim.identity.worktreePath, ".maister-managed", "user-notes"),
    "retain these bytes",
  );
  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
    "retained",
  );
  expect(
    await readFile(
      path.join(claim.identity.worktreePath, ".maister-managed", "user-notes"),
      "utf8",
    ),
  ).toBe("retain these bytes");
  await expect(
    database.pool.query(
      "UPDATE task_launch_intents SET cleanup_state=NULL WHERE id=$1",
      [claim.intentId],
    ),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "task_launch_preparation_cleanup",
  });
});

it("known materialization receipt permits cleanup while incomplete materialization is retained", async () => {
  const complete = await allocated();

  await checkout(complete);
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    await fence.run(async () => {
      const execution = await acceptedTaskLaunchExecution(db, complete);

      await execution.materialize(() =>
        writeFile(
          path.join(complete.identity.worktreePath, "platform.json"),
          "known platform bytes",
        ),
      );
    });
  } finally {
    await fence.release();
  }
  await cancel(complete);
  expect(await cleanupTaskLaunchPreparation(db, complete.intentId)).toBe(
    "removed",
  );
  const partial = await allocated();

  await checkout(partial);
  await advanceTaskLaunchPreparation(db, partial, "materializing");
  await writeFile(
    path.join(partial.identity.worktreePath, "partial.json"),
    "unwitnessed bytes",
  );
  await cancel(partial);
  expect(await cleanupTaskLaunchPreparation(db, partial.intentId)).toBe(
    "retained",
  );
  await access(path.join(partial.identity.worktreePath, "partial.json"));
});

it("a symlinked checkout and a reserved foreign branch are retained", async () => {
  const linked = await prepared();
  const outside = path.join(root, `outside-${linked.identity.runId}`);

  await rename(linked.identity.worktreePath, outside);
  await symlink(outside, linked.identity.worktreePath);
  expect(await cleanupTaskLaunchPreparation(db, linked.intentId)).toBe(
    "retained",
  );
  await access(path.join(outside, ".maister-managed", "provenance"));
  const reserved = await allocated();

  await git(
    fixture.repo,
    "branch",
    reserved.identity.branch,
    reserved.identity.baseCommit,
  );
  await cancel(reserved);
  expect(await cleanupTaskLaunchPreparation(db, reserved.intentId)).toBe(
    "retained",
  );
  expect(
    await localBranchHead({
      projectRepoPath: fixture.repo,
      branch: reserved.identity.branch,
    }),
  ).toBe(reserved.identity.baseCommit);
});

it("a lost removed receipt recovers without recreating the checkout or rewriting the primary diagnosis", async () => {
  const claim = await prepared();
  const [before] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  await database.pool.query(
    "CREATE FUNCTION reject_launch_cleanup_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cleanup stamp unavailable' USING ERRCODE='40001'; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER reject_launch_cleanup_stamp BEFORE UPDATE OF cleanup_state ON task_launch_intents FOR EACH ROW WHEN(NEW.cleanup_state='removed') EXECUTE FUNCTION reject_launch_cleanup_stamp()",
  );
  try {
    await expect(
      cleanupTaskLaunchPreparation(db, claim.intentId),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    await expect(access(claim.identity.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await database.pool.query(
      "DROP TRIGGER reject_launch_cleanup_stamp ON task_launch_intents",
    );
    await database.pool.query("DROP FUNCTION reject_launch_cleanup_stamp()");
  }
  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
    "removed",
  );
  const [after] = await db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  expect(after.reason).toBe(before.reason);
  expect(after.attempts).toBe(before.attempts);
});

it("a real bound Pending Run transfers cleanup to the existing Run lifecycle", async () => {
  const claim = await allocated();
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    await fence.run(async () => {
      const execution = await acceptedTaskLaunchExecution(db, claim);
      const bound = await launchAcceptedTaskRun(execution, db);

      expect(bound.status).toBe("Pending");
    });
  } finally {
    await fence.release();
  }
  expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe("none");
  await access(claim.identity.worktreePath);
  const [boundRun] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, claim.identity.runId));

  expect(boundRun.taskLaunchIntentId).toBe(claim.intentId);
});

it.each([true, false])(
  "an owned slow materialization is protected from orphan GC (guard=$0)",
  async (guarded) => {
    const claim = await allocated();

    await checkout(claim);
    const fence = await acquireRepositoryMutationFence(fixture.repo);
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = fence
      .run(async () => {
        const execution = await acceptedTaskLaunchExecution(db, claim);

        await execution.materialize(async () => {
          await writeFile(
            path.join(claim.identity.worktreePath, "in-progress.json"),
            "owned in-progress bytes",
          );
          entered();
          await resumed;
        });
      })
      .then(
        () => null,
        (error) => error,
      );
    const original = ownership.taskLaunchPreparationOwnsWorktree;
    const spy = guarded
      ? null
      : vi
          .spyOn(ownership, "taskLaunchPreparationOwnsWorktree")
          .mockImplementation((connection, input) =>
            input.runId === claim.identity.runId
              ? Promise.resolve(false)
              : original(connection, input),
          );

    try {
      await Promise.race([
        paused,
        driver.then(() => {
          throw new Error("Materialization ended before pause");
        }),
      ]);
      await cancel(claim);
      const result = await runWorkspaceReconciliationSweep({
        database: db,
        root: process.env.MAISTER_WORKTREES_ROOT,
        executionHosts: hostFixture.hosts,
      });

      if (guarded) {
        await access(claim.identity.worktreePath);
        expect(result.retained).toBeGreaterThan(0);
        const [finding] = await db
          .select()
          .from(workspaceReconciliationFindings)
          .where(
            eq(
              workspaceReconciliationFindings.provenanceRunId,
              claim.identity.runId,
            ),
          );

        expect(finding.resultCode).toBe("launch_intent_owned");
        expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
          "busy",
        );
      } else {
        await expect(access(claim.identity.worktreePath)).rejects.toMatchObject(
          { code: "ENOENT" },
        );
        expect(result.removed).toBeGreaterThan(0);
      }
    } finally {
      release();
      await driver;
      spy?.mockRestore();
      await fence.release();
    }
    expect(await cleanupTaskLaunchPreparation(db, claim.intentId)).toBe(
      "retained",
    );
  },
);

it("untracked user changes and changes after a materialization receipt remain retained", async () => {
  const dirty = await prepared();

  await writeFile(
    path.join(dirty.identity.worktreePath, "user.txt"),
    "preserve user bytes",
  );
  expect(await cleanupTaskLaunchPreparation(db, dirty.intentId)).toBe(
    "retained",
  );
  await access(path.join(dirty.identity.worktreePath, "user.txt"));
  const changed = await allocated();

  await checkout(changed);
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    await fence.run(async () => {
      const execution = await acceptedTaskLaunchExecution(db, changed);

      await execution.materialize(() =>
        writeFile(
          path.join(changed.identity.worktreePath, "platform.json"),
          "witnessed bytes",
        ),
      );
    });
  } finally {
    await fence.release();
  }
  await cancel(changed);
  await writeFile(
    path.join(changed.identity.worktreePath, "platform.json"),
    "changed after receipt",
  );
  expect(await cleanupTaskLaunchPreparation(db, changed.intentId)).toBe(
    "retained",
  );
  expect(
    await readFile(
      path.join(changed.identity.worktreePath, "platform.json"),
      "utf8",
    ),
  ).toBe("changed after receipt");
});

it("a bounded sweep advances past a busy repository without consuming its failure budget", async () => {
  const firstFixture = fixture;

  await database.pool.query(
    "UPDATE projects SET task_key='CLEANUP' WHERE id=$1",
    [firstFixture.projectId],
  );
  const busy = await prepared();
  const fence = await acquireRepositoryMutationFence(firstFixture.repo);
  let free: TaskLaunchFlowClaim | null = null;

  try {
    fixture = await seedTaskLaunchFixture(database, path.join(root, "second"));
    free = await prepared();
    fixture = firstFixture;
    const first = await sweepTaskLaunchPreparationCleanup(db, 1);
    const second = await sweepTaskLaunchPreparationCleanup(db, 1);

    expect(first).toMatchObject({ visited: 1, busy: 1, removed: 0 });
    expect(second).toMatchObject({ visited: 1, removed: 1, busy: 0 });
    await access(busy.identity.worktreePath);
    await expect(access(free.identity.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const [intent] = await db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, busy.intentId));

    expect(intent.attempts).toBe(0);
  } finally {
    fixture = firstFixture;
    await fence.release();
  }
  expect(await cleanupTaskLaunchPreparation(db, busy.intentId)).toBe("removed");
});
