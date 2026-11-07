import type { TaskLaunchReceipt } from "@/lib/tasks/launch-types";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  tasks,
  flows,
  flowRevisions,
  runs,
  executionCommands,
  taskLaunchIntents,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { prepareTaskLaunchIntent } from "@/lib/tasks/launch-dispatch";
import { claimTaskLaunchIntent } from "@/lib/tasks/launch-dispatch-claim";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import { taskLaunchErrorResponse } from "@/lib/tasks/launch-http";
import { cancelInteractiveTaskLaunch } from "@/lib/tasks/launch-cancel";
import { cleanupTaskLaunchPreparation } from "@/lib/tasks/launch-preparation-cleanup";
import { launchAcceptedTaskRun } from "@/lib/services/runs";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { loadRun } from "@/lib/flows/graph/runner-core";
import { runDirPath } from "@/lib/flows/graph/mutation-check";
import { runtimeRoot } from "@/lib/runtime-root";
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

const execFileAsync = promisify(execFile);
let database: StartedPostgresTestDb;
let fixture: TaskLaunchFixture;
let root: string;
let sequence = 0;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "launch_flow_assets",
  });
  root = await mkdtempReal("launch-flow-assets-");
  fixture = await seedTaskLaunchFixture(database, root);
  await fakeExecutionHosts(database.db);
}, 180_000);

afterAll(async () => {
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

async function writeAssets(
  directory: string,
  marker: "A" | "B",
): Promise<void> {
  await writeFile(
    path.join(directory, "verify.sh"),
    `#!/bin/sh\nprintf 'accepted-assets-${marker}\\n'\n`,
  );
  await writeFile(
    path.join(directory, "intake.json"),
    JSON.stringify({
      schemaVersion: 1,
      fields: [
        { name: "environment", type: "string", label: `Environment ${marker}` },
      ],
    }),
  );
}

async function configured(): Promise<{ taskId: string; directory: string }> {
  const taskId = randomUUID();
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const directory = path.join(root, `flow-${flowId}`);

  await mkdir(directory);
  await writeAssets(directory, "A");
  const manifest = {
    schemaVersion: 1,
    name: "Owned Flow asset fixture",
    nodes: [
      {
        id: "verify",
        type: "cli",
        action: { command: 'sh "$MAISTER_FLOW_DIR/verify.sh"' },
        transitions: { success: "intake" },
      },
      {
        id: "intake",
        type: "form",
        settings: { form_schema: "intake.json" },
        transitions: { success: "done" },
      },
    ],
  };

  await database.db.insert(flowRevisions).values({
    id: revisionId,
    flowRefId: flowId,
    source: "local",
    versionLabel: "v1",
    resolvedRevision: "owned-assets",
    manifestDigest: "f".repeat(64),
    manifest,
    schemaVersion: 1,
    installedPath: directory,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await database.db.insert(flows).values({
    id: flowId,
    projectId: fixture.projectId,
    flowRefId: flowId,
    source: "local",
    version: "v1",
    installedPath: directory,
    manifest,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
    enablementState: "Enabled",
    trustStatus: "trusted",
  });
  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Frozen own Flow assets",
    prompt: "Execute the selected Flow assets",
    flowId,
    runnerId: fixture.runnerId,
  });

  return { taskId, directory };
}

async function accept(
  taskId: string,
  expectedSettingsToken?: string,
): Promise<TaskLaunchReceipt> {
  return acceptInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken:
        expectedSettingsToken ??
        (await taskLaunchSettingsToken(database.db, taskId)),
      autoPromote: false,
    },
    randomUUID(),
  );
}

it.each(["preview", "acceptance"] as const)(
  "missing installed Flow assets refuse %s with a safe typed error and no admission",
  async (boundary) => {
    const item = await configured();
    const token =
      boundary === "acceptance"
        ? await taskLaunchSettingsToken(database.db, item.taskId)
        : null;

    await rm(item.directory, { recursive: true });
    let failure: unknown;

    try {
      if (token) await accept(item.taskId, token);
      else await taskLaunchSettingsToken(database.db, item.taskId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "PRECONDITION",
      details: {
        reason: "launch_flow_assets_changed",
        stage: "flow_asset_capture",
      },
      cause: { code: "ENOENT" },
    });
    const response = taskLaunchErrorResponse(failure);
    const body: unknown = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "launch_flow_assets_changed" },
    });
    expect(JSON.stringify(body)).not.toContain(item.directory);
    expect(JSON.stringify(body)).not.toContain("ENOENT");
    expect(
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.taskId, item.taskId)),
    ).toEqual([]);
    expect(
      await database.db.select().from(runs).where(eq(runs.taskId, item.taskId)),
    ).toEqual([]);
    expect(await database.db.select().from(executionCommands)).toEqual([]);
  },
);

it("asset changes after preview refuse acceptance without creating an intent", async () => {
  const item = await configured();
  const previewToken = await taskLaunchSettingsToken(database.db, item.taskId);

  await writeAssets(item.directory, "B");
  await expect(accept(item.taskId, previewToken)).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "launch_settings_changed" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM task_launch_intents WHERE task_id=$1",
        [item.taskId],
      )
    ).rows,
  ).toEqual([]);
});

it("asset changes after acceptance hold preparation before any run or execution command", async () => {
  const item = await configured();
  const accepted = await accept(item.taskId);

  await writeAssets(item.directory, "B");
  expect(
    await prepareTaskLaunchIntent(database.db, accepted.intentId),
  ).toMatchObject({
    state: "held",
    reason: "launch_flow_assets_changed",
    runId: null,
  });
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, item.taskId)),
  ).toEqual([]);
  expect(await database.db.select().from(executionCommands)).toEqual([]);
});

it("bound execution and reconstructed runtime readers consume captured A after the installed source becomes B", async () => {
  const item = await configured();
  const accepted = await accept(item.taskId);
  const claim = await claimTaskLaunchIntent(database.db, accepted.intentId);

  if (!claim) throw new Error("Expected owned Flow fixture claim");
  const fence = await acquireRepositoryMutationFence(fixture.repo);
  let runId: string;

  try {
    runId = (
      await fence.run(async () =>
        launchAcceptedTaskRun(
          await acceptedTaskLaunchExecution(database.db, claim),
          database.db,
        ),
      )
    ).runId;
  } finally {
    await fence.release();
  }
  await writeAssets(item.directory, "B");
  expect(
    await cleanupTaskLaunchPreparation(database.db, accepted.intentId),
  ).toBe("none");
  const loaded = await loadRun(database.db, runId);
  const executeCaptured = async (directory: string): Promise<string> =>
    (
      await execFileAsync("sh", ["-c", 'sh "$MAISTER_FLOW_DIR/verify.sh"'], {
        env: { ...process.env, MAISTER_FLOW_DIR: directory },
      })
    ).stdout.trim();

  expect(await executeCaptured(loaded.flowInstallPath)).toBe(
    "accepted-assets-A",
  );
  expect(loaded.flowInstallPath).not.toBe(item.directory);
  expect(
    JSON.parse(
      await readFile(path.join(loaded.flowInstallPath, "intake.json"), "utf8"),
    ),
  ).toMatchObject({ fields: [{ label: "Environment A" }] });
  vi.resetModules();
  const reconstructed = await (
    await import("@/lib/flows/graph/runner-core")
  ).loadRun(database.db, runId);

  expect(await executeCaptured(reconstructed.flowInstallPath)).toBe(
    "accepted-assets-A",
  );
  expect(reconstructed.flowInstallPath).toBe(loaded.flowInstallPath);
  await rm(loaded.flowInstallPath, { recursive: true });
  await expect(loadRun(database.db, runId)).rejects.toMatchObject({
    code: "PRECONDITION",
    details: {
      reason: "launch_flow_assets_changed",
      stage: "flow_asset_capture",
    },
    cause: { code: "ENOENT" },
  });
  expect(await executeCaptured(item.directory)).toBe("accepted-assets-B");
  expect(
    await database.db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.runId, runId)),
  ).toEqual([]);
});

it("closed unbound preparation removes its verified private Flow capture while retaining the original installation", async () => {
  const item = await configured();
  const accepted = await accept(item.taskId);
  const claim = await claimTaskLaunchIntent(database.db, accepted.intentId);

  if (!claim) throw new Error("Expected owned Flow cleanup fixture claim");
  const directory = runDirPath(
    runtimeRoot(),
    fixture.projectId,
    claim.identity.runId,
  );
  const assets = path.join(directory, "accepted-flow");
  const witness = path.join(directory, "accepted-flow.json");

  await database.pool.query(
    "CREATE FUNCTION reject_owned_flow_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned fixture run binding unavailable' USING ERRCODE='40001'; END $$",
  );
  await database.pool.query(
    `CREATE TRIGGER reject_owned_flow_run BEFORE INSERT ON runs FOR EACH ROW WHEN(NEW.task_launch_intent_id='${accepted.intentId}') EXECUTE FUNCTION reject_owned_flow_run()`,
  );
  try {
    const fence = await acquireRepositoryMutationFence(fixture.repo);

    try {
      await expect(
        fence.run(async () =>
          launchAcceptedTaskRun(
            await acceptedTaskLaunchExecution(database.db, claim),
            database.db,
          ),
        ),
      ).rejects.toMatchObject({
        code: "CRASH",
        details: { sqlState: "40001" },
      });
    } finally {
      await fence.release();
    }
  } finally {
    await database.pool.query("DROP TRIGGER reject_owned_flow_run ON runs");
    await database.pool.query("DROP FUNCTION reject_owned_flow_run()");
  }
  const [prepared] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, accepted.intentId));

  expect(prepared).toMatchObject({
    runId: null,
    originalRunId: null,
    preparationPhase: "materialized",
  });
  expect(await readFile(path.join(assets, "verify.sh"), "utf8")).toContain(
    "accepted-assets-A",
  );
  expect(JSON.parse(await readFile(witness, "utf8"))).toMatchObject({
    intentId: accepted.intentId,
    runId: claim.identity.runId,
    incarnationId: claim.identity.incarnationId,
  });
  expect(
    await database.db.select().from(runs).where(eq(runs.taskId, item.taskId)),
  ).toEqual([]);
  await cancelInteractiveTaskLaunch(
    database.db,
    await interactiveTaskLaunchPrincipal(),
    accepted.intentId,
    { expectedStateVersion: prepared.stateVersion },
    randomUUID(),
  );
  expect(
    await cleanupTaskLaunchPreparation(database.db, accepted.intentId),
  ).toBe("removed");
  await expect(
    readFile(path.join(assets, "verify.sh"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(witness, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    await readFile(path.join(item.directory, "verify.sh"), "utf8"),
  ).toContain("accepted-assets-A");
  expect(
    await cleanupTaskLaunchPreparation(database.db, accepted.intentId),
  ).toBe("removed");
  expect(
    (
      await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, accepted.intentId))
    )[0],
  ).toMatchObject({
    cleanupState: "removed",
    runId: null,
    originalRunId: null,
  });
});

it("refuses a project ancestor symlink before writing Flow assets outside the configured manager root", async () => {
  const item = await configured();
  const manager = path.join(root, "manager-containment");
  const outside = path.join(root, "outside-manager");
  const originalRuntime = process.env.MAISTER_RUNTIME_ROOT;

  await mkdir(path.join(manager, ".maister"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(manager, ".maister", fixture.projectId));
  process.env.MAISTER_RUNTIME_ROOT = manager;
  try {
    const accepted = await accept(item.taskId);
    const result = await prepareTaskLaunchIntent(
      database.db,
      accepted.intentId,
    );

    expect(result).toMatchObject({ state: "held", runId: null });
    expect(
      await readFile(path.join(item.directory, "verify.sh"), "utf8"),
    ).toContain("accepted-assets-A");
    const [intent] = await database.db
      .select()
      .from(taskLaunchIntents)
      .where(eq(taskLaunchIntents.id, accepted.intentId));

    if (!intent.preparationIdentity)
      throw new Error("Expected a durable preparation identity");
    await expect(
      readFile(
        path.join(
          outside,
          "runs",
          intent.preparationIdentity.runId,
          "accepted-flow",
          "verify.sh",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await database.db.select().from(runs).where(eq(runs.taskId, item.taskId)),
    ).toEqual([]);
  } finally {
    if (originalRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
    else process.env.MAISTER_RUNTIME_ROOT = originalRuntime;
  }
});
