import type { TaskLaunchClaim } from "@/lib/tasks/launch-dispatch-claim";

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  readlink,
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
  capabilityImports,
  runs,
  executionCommands,
} from "@/lib/db/schema";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import {
  acceptInteractiveTaskLaunch,
  taskLaunchSettingsToken,
} from "@/lib/tasks/launch-intent";
import { claimTaskLaunchIntent } from "@/lib/tasks/launch-dispatch-claim";
import { acceptedTaskLaunchExecution } from "@/lib/tasks/launch-execution";
import { launchAcceptedTaskRun } from "@/lib/services/runs";
import { prepareTaskLaunchFirstDispatch } from "@/lib/tasks/launch-first-dispatch";
import { captureTaskLaunchCapabilityBundles } from "@/lib/tasks/launch-capabilities";
import { withTaskLaunchCapabilityBundles } from "@/lib/tasks/launch-capability-materialization";
import { acquireRepositoryMutationFence } from "@/lib/project-config-persistence/repository-lock";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
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

const barrier = vi.hoisted(() => ({
  sourceDirectory: "",
  sourceRoot: "",
  sourceFile: "",
  entered: () => {},
  released: Promise.resolve(),
  didCopy: false,
  artifactSources: [] as string[],
}));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();

  return {
    ...fs,
    cp: async (...args: Parameters<typeof fs.cp>): Promise<void> => {
      if (String(args[1]).endsWith("/.claude/skills/copy-proof"))
        barrier.artifactSources.push(String(args[0]));
      if (
        ![barrier.sourceDirectory, barrier.sourceRoot].includes(String(args[0]))
      )
        return fs.cp(...args);
      barrier.entered();
      await barrier.released;
      await fs.cp(...args);
      barrier.didCopy = true;
      await fs.writeFile(barrier.sourceFile, "accepted bundle A\n");
    },
  };
});
let database: StartedPostgresTestDb;
let root = "";
let fixture: TaskLaunchFixture;
let bundle = "";
let skillDirectory = "";
let skillFile = "";
let sequence = 0;
const originalWorktrees = process.env.MAISTER_WORKTREES_ROOT;
const originalRuntime = process.env.MAISTER_RUNTIME_ROOT;

vi.mock("@/lib/authz", async (original) => ({
  ...(await original<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: fixture.userId }),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "launch_capability_materialization",
  });
  root = await mkdtempReal("launch-capability-materialization-");
  process.env.MAISTER_WORKTREES_ROOT = path.join(root, "worktrees");
  process.env.MAISTER_RUNTIME_ROOT = path.join(root, "manager");
  await mkdir(path.join(root, "manager"), { recursive: true });
  fixture = await seedTaskLaunchFixture(database, root);
  await fakeExecutionHosts(database.db);
  bundle = path.join(root, "bundle");
  skillDirectory = path.join(bundle, "skills", "copy-proof");
  skillFile = path.join(skillDirectory, "SKILL.md");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(skillFile, "accepted bundle A\n");
  await symlink("SKILL.md", path.join(skillDirectory, "linked.md"));
  await mkdir(path.join(bundle, "skills", "repo-owned"), { recursive: true });
  await writeFile(
    path.join(bundle, "skills", "repo-owned", "SKILL.md"),
    "bundle must not replace repo content\n",
  );
  await mkdir(path.join(fixture.repo, ".claude", "skills", "repo-owned"), {
    recursive: true,
  });
  await writeFile(
    path.join(fixture.repo, ".claude", "skills", "repo-owned", "SKILL.md"),
    "repo wins\n",
  );
  await git(fixture.repo, "add", ".claude");
  await git(fixture.repo, "commit", "-q", "-m", "Repository-owned skill");
  await database.db.insert(capabilityImports).values({
    id: randomUUID(),
    projectId: fixture.projectId,
    capabilityRefId: "copy-proof",
    source: "local",
    versionTag: "v1",
    resolvedRevision: "a".repeat(40),
    manifestDigest: "a".repeat(64),
    manifest: {},
    installedPath: bundle,
    setupStatus: "not_required",
    packageStatus: "Installed",
    trustStatus: "trusted",
  });
}, 180_000);

afterAll(async () => {
  if (originalWorktrees === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = originalWorktrees;
  if (originalRuntime === undefined) delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = originalRuntime;
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function allocated(): Promise<TaskLaunchClaim> {
  const taskId = randomUUID();
  const db = database.db;

  await db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: ++sequence,
    title: "Frozen capabilities",
    prompt: "Use the exact accepted bundle",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  const accepted = await acceptInteractiveTaskLaunch(
    db,
    await interactiveTaskLaunchPrincipal(),
    {
      taskId,
      expectedTaskRevision: 0,
      expectedSettingsToken: await taskLaunchSettingsToken(db, taskId),
      autoPromote: false,
    },
    randomUUID(),
  );
  const claim = await claimTaskLaunchIntent(db, accepted.intentId);

  if (!claim) throw new Error("Fixture did not claim the accepted launch");

  return claim;
}

async function bind(
  claim: TaskLaunchClaim,
): Promise<{ runId: string; status: string }> {
  const fence = await acquireRepositoryMutationFence(fixture.repo);

  try {
    return await fence.run(async () =>
      launchAcceptedTaskRun(
        await acceptedTaskLaunchExecution(database.db, claim),
        database.db,
      ),
    );
  } finally {
    await fence.release();
  }
}

async function assertNoDispatch(claim: TaskLaunchClaim): Promise<void> {
  expect(
    await database.db
      .select()
      .from(runs)
      .where(eq(runs.taskLaunchIntentId, claim.intentId)),
  ).toEqual([]);
  expect(
    await database.db
      .select()
      .from(executionCommands)
      .where(eq(executionCommands.runId, claim.identity.runId)),
  ).toEqual([]);
}

it("binds only verified private bytes, preserves repo entries and relative links after capture cleanup", async () => {
  const claim = await allocated();
  const bound = await bind(claim);
  const copied = path.join(
    claim.identity.worktreePath,
    ".claude",
    "skills",
    "copy-proof",
  );

  expect(bound.status).toBe("Pending");
  expect(await readFile(path.join(copied, "SKILL.md"), "utf8")).toBe(
    "accepted bundle A\n",
  );
  expect(await readlink(path.join(copied, "linked.md"))).toBe("SKILL.md");
  expect(await readFile(path.join(copied, "linked.md"), "utf8")).toBe(
    "accepted bundle A\n",
  );
  expect(
    await readFile(
      path.join(
        claim.identity.worktreePath,
        ".claude/skills/repo-owned/SKILL.md",
      ),
      "utf8",
    ),
  ).toBe("repo wins\n");
  expect(barrier.artifactSources).toHaveLength(1);
  expect(barrier.artifactSources[0]).toContain("capability-capture-");
  const runtimeDirectory = path.join(
    root,
    "manager",
    ".maister",
    fixture.projectId,
    "runs",
    bound.runId,
  );

  expect(
    (await readdir(runtimeDirectory)).some((name) =>
      name.startsWith("capability-capture-"),
    ),
  ).toBe(false);
  const dispatch = await prepareTaskLaunchFirstDispatch(
    database.db,
    bound.runId,
  );

  if (!dispatch)
    throw new Error("Bound fixture has no first-dispatch authority");
  await database.db.transaction(dispatch.apply);
});

it("refuses a capture ancestor symlink before copying or consuming an accepted bundle", async () => {
  const claim = await allocated();
  const outside = path.join(root, "outside-capture");
  const redirect = path.join(root, "manager", "capability-redirect");
  const bundles = await captureTaskLaunchCapabilityBundles(
    database.db,
    fixture.projectId,
  );
  let consumed = false;

  await mkdir(outside);
  await writeFile(
    path.join(outside, "sentinel.txt"),
    "Outside directory unchanged",
  );
  await symlink(outside, redirect);
  try {
    const outcome = await withTaskLaunchCapabilityBundles(
      database.db,
      {
        projectId: fixture.projectId,
        intentId: claim.intentId,
        runId: claim.identity.runId,
        directory: path.join(redirect, claim.identity.runId),
        bundles,
      },
      async () => {
        consumed = true;
      },
    ).then(
      () => ({ kind: "consumed" as const }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );

    expect(await readdir(outside)).toEqual(["sentinel.txt"]);
    expect(outcome).toMatchObject({
      kind: "refused",
      error: { code: "CONFIG" },
    });
    expect(consumed).toBe(false);
    expect(await readFile(path.join(outside, "sentinel.txt"), "utf8")).toBe(
      "Outside directory unchanged",
    );
    await assertNoDispatch(claim);
  } finally {
    await rm(redirect);
  }
});

it("refuses copied bundle bytes that differ from admission despite restored source hashes", async () => {
  const claim = await allocated();
  const acceptedBundles = await captureTaskLaunchCapabilityBundles(
    database.db,
    fixture.projectId,
  );
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });

  barrier.released = new Promise<void>((resolve) => {
    release = resolve;
  });
  barrier.sourceRoot = bundle;
  barrier.sourceDirectory = skillDirectory;
  barrier.sourceFile = skillFile;
  barrier.entered = enter;
  const driver = bind(claim);
  const outcome = driver.then(
    (value) => ({ kind: "bound" as const, value }),
    (error: unknown) => ({ kind: "refused" as const, error }),
  );

  try {
    await Promise.race([
      entered,
      driver.then(() => {
        throw new Error("Driver ended before the actual copy barrier");
      }),
    ]);
    await writeFile(skillFile, "intervening bundle B\n");
  } finally {
    release();
  }
  const result = await outcome;

  expect(result).toMatchObject({
    kind: "refused",
    error: {
      code: "PRECONDITION",
      details: { reason: "launch_capabilities_changed" },
    },
  });
  expect(barrier.didCopy).toBe(true);
  expect(await readFile(skillFile, "utf8")).toBe("accepted bundle A\n");
  expect(
    await captureTaskLaunchCapabilityBundles(database.db, fixture.projectId),
  ).toEqual(acceptedBundles);
  await assertNoDispatch(claim);
  const [intent] = await database.db
    .select()
    .from(taskLaunchIntents)
    .where(eq(taskLaunchIntents.id, claim.intentId));

  expect(intent.dispatchCommittedAt).toBeNull();
  expect(intent.preparationPhase).toBe("materializing");
  const directory = path.join(
    root,
    "manager",
    ".maister",
    fixture.projectId,
    "runs",
    claim.identity.runId,
  );

  expect(
    (await readdir(directory)).filter((entry) =>
      entry.startsWith("capability-capture-"),
    ),
  ).toEqual([]);
});

it.each(["outside", "uncopied"] as const)(
  "refuses a bundle link into %s content without dispatch",
  async (targetKind) => {
    barrier.sourceRoot = "";
    barrier.sourceDirectory = "";
    const outside =
      targetKind === "outside"
        ? path.join(root, "outside-private.txt")
        : path.join(bundle, "docs", "not-materialized.txt");

    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "PRIVATE_BUNDLE_TARGET_SENTINEL");
    const link = path.join(skillDirectory, "outside.md");

    await symlink(path.relative(skillDirectory, outside), link);
    try {
      const claim = await allocated();

      await expect(bind(claim)).rejects.toMatchObject({
        code: "PRECONDITION",
        details: { reason: "launch_capabilities_changed" },
      });
      await assertNoDispatch(claim);
      const [intent] = await database.db
        .select()
        .from(taskLaunchIntents)
        .where(eq(taskLaunchIntents.id, claim.intentId));

      expect(JSON.stringify(intent.settingsSnapshot)).not.toContain(
        "PRIVATE_BUNDLE_TARGET_SENTINEL",
      );
      expect(
        (
          await readdir(
            path.join(
              root,
              "manager",
              ".maister",
              fixture.projectId,
              "runs",
              claim.identity.runId,
            ),
          )
        ).filter((entry) => entry.startsWith("capability-capture-")),
      ).toEqual([]);
    } finally {
      await rm(link);
    }
  },
);
