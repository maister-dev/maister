import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ADR-132 §a integration proof on real Postgres: an ephemeral pin (direct
// `packagePin` and the `try_once` launch choice) resolves the run's flow
// revision from the pinned install while `project_package_attachments` stays
// BYTE-IDENTICAL, and a refused pin leaves no run/workspace behind
// (compensation completeness). Fixtures are `nodes[]` DSL only.

const checkSupervisorHealthMock = vi.fn(async () => ({
  kind: "ready" as const,
  health: {
    status: "ready",
    host: TEST_HOST_IDENTITY,
    version: "0.0.1",
    uptimeMs: 1,
    checkedAt: new Date().toISOString(),
    sessions: { live: 0, exited: 0, crashed: 0 },
  },
}));
const addWorktreeMock = vi.fn(async (_input: unknown) => undefined);
const removeWorktreeMock = vi.fn(async (_input: unknown) => undefined);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
    getExecutionHostCapabilities: async () => readyExecutionHostCapabilities(),
  };
});
vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: async (input: Parameters<typeof actual.addWorktree>[0]) => {
      await addWorktreeMock(input);

      return actual.addWorktree(input);
    },
    removeWorktree: async (
      input: Parameters<typeof actual.removeWorktree>[0],
    ) => {
      await removeWorktreeMock(input);

      return actual.removeWorktree(input);
    },
    listBranches: async () => ["main", "develop"],
    listRemoteUrls: async () => [],
  };
});
// Keep launched runs Pending — no scheduler slot, no runner spawn.
vi.mock("@/lib/scheduler", async (original) => ({
  ...(await original<typeof import("@/lib/scheduler")>()),
  tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
}));

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import {
  seedAcceptedRepositoryQualification,
  isolateEngineFixtureRuntime,
} from "@/test-support/repository-qualification";
import { launchEvaluationEngineFixture } from "@/test-support/evaluation-engine-launch";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import { runtimeRoot } from "@/lib/runtime-root";
import { initRepo as initFixtureRepo } from "@/test-support/git-fixture";
import { gitCommitWorkingDir } from "@/lib/local-packages/git";
import {
  addFlowToLocalPackage,
  createLocalPackageWithFlow,
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import { acquireLock, releaseLock } from "@/lib/local-packages/lock";
import { cutLocalPackageVersion } from "@/lib/local-packages/versions";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";
import {
  listEligiblePinInstalls,
  resolvePinnedFlowRevisionForRefId,
} from "@/lib/packages/pin";
import { launchQualifiedEngineRun as launchRun } from "@/test-support/launch-engine-response";
import { MaisterError } from "@/lib/errors";
import {
  createScheduledLaunch,
  claimScheduledLaunch,
  dispatchClaimedScheduledLaunch,
} from "@/lib/scheduled-launches/service";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  readyExecutionHostCapabilities,
  TEST_HOST_IDENTITY,
} from "@/test-support/supervisor-health-fixture";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let runtimeRootDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let restoreEngineRuntime: (() => Promise<void>) | undefined;
let userId: string;

// nodes[] DSL only (plan rule — no legacy steps[]). All-instruct settings pass
// the M11c enforcement gate so the launch reaches run persistence.
const FLOW_YAML = (name: string, marker: string): string =>
  [
    "schemaVersion: 1",
    `name: ${name}`,
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: implement",
    "    type: ai_coding",
    "    action:",
    `      prompt: "/aif-implement ${marker}"`,
    "    transitions:",
    "      success: done",
    "    settings:",
    "      enforcement:",
    "        mcps: instruct",
    "",
  ].join("\n");

const MANIFEST = (name: string, flowId: string): string =>
  `schemaVersion: 1\nname: ${name}\nflows:\n  - { id: ${flowId}, path: flows/${flowId} }\ncapabilities: []\n`;

// A flow whose first node is a form intake — the Codex-1 evaluationFormInputs
// pre-write targets exactly this node's declared fields.
const FORM_FLOW_YAML = (name: string): string =>
  [
    "schemaVersion: 1",
    `name: ${name}`,
    "compat:",
    "  engine_min: 1.1.0",
    "nodes:",
    "  - id: intake",
    "    type: form",
    "    settings:",
    "      form_schema: schemas/intake.json",
    "    transitions:",
    "      success: implement",
    "  - id: implement",
    "    type: ai_coding",
    "    action:",
    '      prompt: "/aif-implement form"',
    "    transitions:",
    "      success: done",
    "    settings:",
    "      enforcement:",
    "        mcps: instruct",
    "",
  ].join("\n");

const FORM_DOC_JSON = JSON.stringify(
  {
    schemaVersion: 1,
    fields: [
      { name: "environment", type: "string", required: true },
      { name: "notes", type: "string" },
    ],
  },
  null,
  2,
);

async function buildSourcePackage(
  root: string,
  name: string,
  flowId: string,
): Promise<void> {
  await mkdir(join(root, `flows/${flowId}`), { recursive: true });
  await writeFile(
    join(root, `flows/${flowId}/flow.yaml`),
    FLOW_YAML(flowId, "v1"),
  );
  await writeFile(join(root, "maister-package.yaml"), MANIFEST(name, flowId));
}

async function installSource(name: string, flowId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pin-src-${name}-`));

  await buildSourcePackage(dir, name, flowId);
  const installed = await installPackageRevision({
    source: dir,
    version: `${name}/v1.0.0`,
    trustStatus: "trusted_by_policy",
    db,
  });

  await rm(dir, { recursive: true, force: true });

  return installed.id;
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "launchpin_test",
  });
  container = testDatabase.container;
  db = testDatabase.db;

  homeDir = await mkdtempReal("launchpin-int-home-");
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
  restoreEngineRuntime = await isolateEngineFixtureRuntime();
  runtimeRootDir = runtimeRoot();

  userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId}@x.test`,
    name: "Pin Author",
    accountStatus: "active",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow("claude-default", "claude"));
  await db.insert(schema.platformRuntimeSettings).values({
    id: "singleton",
    defaultRunnerId: "claude-default",
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await restoreEngineRuntime?.();
  await closeDb();
  await testDatabase?.stop();
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  addWorktreeMock.mockClear();
  removeWorktreeMock.mockClear();
});

async function createProject(): Promise<{
  id: string;
  slug: string;
  repoPath: string;
}> {
  const id = randomUUID();
  const slug = `pin-${id.slice(0, 8)}`;
  const repoPath = join(homeDir, `repo-${id.slice(0, 8)}`);

  await initFixtureRepo(repoPath);
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: `Pin Proj ${slug}`,
    repoPath,
  });

  await db
    .insert(schema.projectMembers)
    .values({ id: randomUUID(), projectId: id, userId, role: "owner" });

  return { id, slug, repoPath };
}

// Create the canonical local package and its first Flow, add another Flow,
// commit/cut/attach v1, then cut v2. This deliberately exercises the real
// Studio create contract instead of creating another DB-authored Flow path.
async function forkAttachWithNewerCut(
  project: { id: string; slug: string; repoPath: string },
  sourceName: string,
  flowId: string,
): Promise<{
  pinInstallId: string;
  attachmentId: string;
  cut2InstallId: string;
  flowRowId: string;
}> {
  const { package: created } = await createLocalPackageWithFlow({
    name: sourceName,
    createdBy: userId,
    flow: {
      id: flowId,
      metadata: {
        title: `${flowId} title`,
        summary: "Canonical initial Flow.",
        route_when: "A task needs this Flow.",
      },
    },
    db,
  });
  const pkg = await getLocalPackage(created.id, db);

  await acquireLock(pkg!.id, userId, `canonical-${flowId}`, db);
  try {
    await addFlowToLocalPackage({
      packageId: pkg!.id,
      sessionId: `canonical-${flowId}`,
      flow: {
        id: `${flowId}-second`,
        metadata: {
          title: "Second Flow",
          summary: "Additional canonical Flow.",
          route_when: "A second route is needed.",
        },
      },
      db,
    });
  } finally {
    await releaseLock(pkg!.id, `canonical-${flowId}`, db);
  }

  // The starter graph is graph-valid and safely inert; use the all-CLI graph
  // here so the attached immutable revision is also suitable for real launch
  // coverage without introducing a Flow DSL extension.
  await writeWorkingDirFile(
    pkg!,
    `flows/${flowId}/flow.yaml`,
    FLOW_YAML(flowId, "v1"),
  );
  await gitCommitWorkingDir(pkg!.workingDir, "canonical initial package");
  const cut1 = await cutLocalPackageVersion(pkg!, { db });
  const attached = await attachPackage({
    projectId: project.id,
    projectSlug: project.slug,
    packageInstallId: cut1.installId,
    workspaceRoot: project.repoPath,
    db,
  });

  await writeWorkingDirFile(
    pkg!,
    `flows/${flowId}/flow.yaml`,
    FLOW_YAML(flowId, "v2"),
  );
  await gitCommitWorkingDir(pkg!.workingDir, "v2 edit");
  const freshPkg = await getLocalPackage(created.id, db);
  const cut2 = await cutLocalPackageVersion(freshPkg!, { db });

  const flowRows = await db
    .select()
    .from(schema.flows)
    .where(
      and(
        eq(schema.flows.projectId, project.id),
        eq(schema.flows.flowRefId, flowId),
      ),
    );

  return {
    pinInstallId: cut1.installId,
    attachmentId: attached!.attachmentId,
    cut2InstallId: cut2.installId,
    flowRowId: flowRows[0]!.id as string,
  };
}

// Create + cut + attach a single-version package whose flow carries a form
// intake node (Codex-1 form-input pre-write coverage).
async function attachFormFlow(
  project: { id: string; slug: string; repoPath: string },
  sourceName: string,
  flowId: string,
): Promise<{ flowRowId: string }> {
  const { package: created } = await createLocalPackageWithFlow({
    name: sourceName,
    createdBy: userId,
    flow: {
      id: flowId,
      metadata: {
        title: `${flowId} title`,
        summary: "Form intake flow.",
        route_when: "A task needs a form intake.",
      },
    },
    db,
  });
  const pkg = await getLocalPackage(created.id, db);

  await writeWorkingDirFile(
    pkg!,
    `flows/${flowId}/flow.yaml`,
    FORM_FLOW_YAML(flowId),
  );
  // Form-schema docs live at the PACKAGE ROOT `schemas/` (the cut copies them
  // into every member flow revision — artifact-validate contract).
  await writeWorkingDirFile(pkg!, "schemas/intake.json", FORM_DOC_JSON);
  await gitCommitWorkingDir(pkg!.workingDir, "form intake flow");
  const cut = await cutLocalPackageVersion(pkg!, { db });

  await attachPackage({
    projectId: project.id,
    projectSlug: project.slug,
    packageInstallId: cut.installId,
    workspaceRoot: project.repoPath,
    db,
  });

  const flowRows = await db
    .select()
    .from(schema.flows)
    .where(
      and(
        eq(schema.flows.projectId, project.id),
        eq(schema.flows.flowRefId, flowId),
      ),
    );

  return { flowRowId: flowRows[0]!.id as string };
}

async function seedTask(taskId: string, projectId: string, flowRowId: string) {
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "pin task",
    prompt: "do it",
    flowId: flowRowId,
  });
  await seedAcceptedRepositoryQualification(testDatabase.db, projectId, taskId);
}

async function attachmentRow(
  attachmentId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(schema.projectPackageAttachments)
    .where(eq(schema.projectPackageAttachments.id, attachmentId));

  return rows[0] as Record<string, unknown>;
}

async function revisionOfInstall(
  installId: string,
  flowRefId: string,
): Promise<Record<string, any>> {
  const [install] = await db
    .select()
    .from(schema.packageInstalls)
    .where(eq(schema.packageInstalls.id, installId));
  const rows = await db
    .select()
    .from(schema.flowRevisions)
    .where(
      and(
        eq(schema.flowRevisions.flowRefId, flowRefId),
        eq(schema.flowRevisions.resolvedRevision, install.resolvedRevision),
      ),
    );

  return rows[0];
}

function ctx() {
  return { actorUserId: userId, authorize: async () => undefined };
}

describe("launchRun packagePin (integration, real Postgres)", () => {
  it("IT-CPC-11: DB-only pinned launches consume project runner changes and preserve existing snapshots", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(project, "pinpkg", "flow-pin");

    const selectedRunnerId = randomUUID();

    await db
      .insert(schema.platformAcpRunners)
      .values(testPlatformRunnerRow(selectedRunnerId, "claude"));
    await db
      .update(schema.projects)
      .set({ defaultRunnerId: selectedRunnerId })
      .where(eq(schema.projects.id, project.id));
    const [registered] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));

    expect(registered.maisterYamlPath).toBeNull();

    await seedTask("task-pin-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    const result = await launchRun(
      {
        taskId: "task-pin-1",
        packageVersions: { [fx.pinInstallId]: "try_once" },
      },
      ctx(),
      db as never,
    );

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));
    const pinnedRevision = await revisionOfInstall(
      fx.cut2InstallId,
      "flow-pin",
    );

    expect(run.flowRevisionId).toBe(pinnedRevision.id);
    expect(run.flowRevision).toBe(pinnedRevision.resolvedRevision);
    expect(run.flowVersion).toBe(pinnedRevision.versionLabel);

    const [firstSession] = await db
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, result.runId));

    expect(firstSession).toMatchObject({
      runnerId: selectedRunnerId,
      runnerSnapshot: { id: selectedRunnerId },
    });
    await db
      .update(schema.projects)
      .set({ defaultRunnerId: "claude-default" })
      .where(eq(schema.projects.id, project.id));
    await seedTask("task-pin-runner-change", project.id, fx.flowRowId);
    const next = await launchRun(
      {
        taskId: "task-pin-runner-change",
        packageVersions: { [fx.pinInstallId]: "try_once" },
      },
      ctx(),
      db as never,
    );
    const [nextSession] = await db
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, next.runId));

    expect(nextSession).toMatchObject({
      runnerId: "claude-default",
      runnerSnapshot: { id: "claude-default" },
    });
    const [preserved] = await db
      .select()
      .from(schema.runSessions)
      .where(eq(schema.runSessions.runId, result.runId));

    expect(preserved).toEqual(firstSession);
    await expect(
      readFile(join(project.repoPath, "maister.yaml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Full-row compare incl. packageInstallId + attachedAt — the pin NEVER
    // mutates the attachment.
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });

  it("a try_once launch pins the run to the newer cut with the attachment untouched", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(project, "trypkg", "flow-try");

    await seedTask("task-try-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    const result = await launchRun(
      {
        taskId: "task-try-1",
        packageVersions: { [fx.pinInstallId]: "try_once" },
      },
      ctx(),
      db as never,
    );

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));
    const cut2Revision = await revisionOfInstall(fx.cut2InstallId, "flow-try");

    expect(run.flowRevisionId).toBe(cut2Revision.id);
    expect(run.flowVersion).toBe(cut2Revision.versionLabel);
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });

  it("a pin on an install lacking the flow refuses CONFIG — no run, no workspace, attachment untouched", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(project, "mainpkg", "flow-main");
    // A second, unrelated install that ships a DIFFERENT flow id.
    const strangerInstallId = await installSource("strangerpkg", "flow-other");

    await seedTask("task-refuse-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    await expect(
      resolvePinnedFlowRevisionForRefId(db, {
        flowRefId: "flow-main",
        packageInstallId: strangerInstallId,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    await expect(
      launchRun(
        {
          taskId: "task-refuse-1",
          packageVersions: { [strangerInstallId]: "try_once" },
        },
        ctx(),
        db,
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "launch_package_changed" },
    });

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-refuse-1"));
    const workspaceRows = await db.select().from(schema.workspaces);

    expect(runRows).toHaveLength(0);
    expect(
      workspaceRows.filter((w: any) => w.projectId === project.id),
    ).toHaveLength(0);
    expect(addWorktreeMock).not.toHaveBeenCalled();
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });

  // Codex-1 (ADR-150 · C): the evaluation seam pins the run to the RECIPE's
  // exact flow revision — the run must execute that revision (the runner loads
  // its manifest from runs.flow_revision_id), not the live enabled one.
  it("honors an evaluationFlowRevisionId pin over the enabled revision (Codex-1)", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(project, "evalpin", "flow-evalpin");

    await seedTask("task-evalpin-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);
    const pinned = await revisionOfInstall(fx.cut2InstallId, "flow-evalpin");

    const result = await launchEvaluationEngineFixture(
      db,
      { taskId: "task-evalpin-1", flowRevisionId: pinned.id },
      ctx(),
    );

    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));

    expect(run.flowRevisionId).toBe(pinned.id);
    expect(run.flowRevision).toBe(pinned.resolvedRevision);
    expect(run.flowVersion).toBe(pinned.versionLabel);
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });

  it("refuses an evaluation pin whose revision belongs to another flow — no run, no worktree (Codex-1)", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(
      project,
      "evalforeign",
      "flow-evalforeign",
    );
    const strangerInstallId = await installSource(
      "evalstranger",
      "flow-evalstranger",
    );
    const foreign = await revisionOfInstall(
      strangerInstallId,
      "flow-evalstranger",
    );

    await seedTask("task-evalforeign-1", project.id, fx.flowRowId);

    await expect(
      launchEvaluationEngineFixture(
        db,
        { taskId: "task-evalforeign-1", flowRevisionId: foreign.id },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-evalforeign-1"));

    expect(runRows).toHaveLength(0);
    expect(addWorktreeMock).not.toHaveBeenCalled();
  });

  it("pre-writes evaluationFormInputs as the form node's input artifact (Codex-1)", async () => {
    const project = await createProject();
    const fx = await attachFormFlow(project, "evalform", "flow-evalform");

    await seedTask("task-evalform-1", project.id, fx.flowRowId);

    await expect(
      launchEvaluationEngineFixture(
        db,
        {
          taskId: "task-evalform-1",
          formInputs: {
            environment: "staging",
            notes: "controlled run",
            unknownField: "not declared by the node",
          },
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.taskId, "task-evalform-1")),
    ).toEqual([]);
    const result = await launchEvaluationEngineFixture(
      db,
      {
        taskId: "task-evalform-1",
        formInputs: { environment: "staging", notes: "controlled run" },
      },
      ctx(),
    );

    const artifactPath = join(
      runtimeRootDir,
      ".maister",
      project.slug,
      "runs",
      result.runId,
      "input-intake.json",
    );
    const written = JSON.parse(await readFile(artifactPath, "utf8"));

    // Only the node's DECLARED fields are written — never a stray key.
    expect(written).toEqual({
      environment: "staging",
      notes: "controlled run",
    });
  });

  // Test-Matrix Row 5 (feature-experiments-cutover): a pin that is ELIGIBLE
  // when the recipe is created but becomes INELIGIBLE by launch time must be
  // refused at launch — never silently launched on a stale/invalid pin. The
  // create-side eligibility feed (`listEligiblePinInstalls`) and the launch-side
  // re-validation (`resolvePinnedFlowRevisionForRefId`, the exact matrix
  // `launchRun` re-runs) share ONE predicate set in `lib/packages/pin.ts`, so
  // both sides must AGREE across the eligible→ineligible transition (parity).
  it("a pin eligible in the create-feed is refused at launch once the install is removed (create ↔ launch re-validate parity)", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(
      project,
      "paritypkg",
      "flow-parity",
    );

    await seedTask("task-parity-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    // Eligible now: the create-side picker feed offers the newer cut, and the
    // launch-side matrix resolves it — both sides admit the pin.
    const eligibleBefore = await listEligiblePinInstalls({
      db,
      taskId: "task-parity-1",
    });

    expect(eligibleBefore.map((o) => o.packageInstallId)).toContain(
      fx.cut2InstallId,
    );
    await expect(
      resolvePinnedFlowRevisionForRefId(db, {
        flowRefId: "flow-parity",
        packageInstallId: fx.cut2InstallId,
      }),
    ).resolves.toBeDefined();

    // The pinned install is removed AFTER the recipe was creatable — the shared
    // `package_status = 'Installed'` predicate now fails for it.
    await db
      .update(schema.packageInstalls)
      .set({ packageStatus: "Removed" })
      .where(eq(schema.packageInstalls.id, fx.cut2InstallId));

    // Create-side: the feed no longer offers it (a recipe could not be built on
    // it now), while a still-eligible sibling cut stays offered — surgical flip.
    const eligibleAfter = await listEligiblePinInstalls({
      db,
      taskId: "task-parity-1",
    });
    const idsAfter = eligibleAfter.map((o) => o.packageInstallId);

    expect(idsAfter).not.toContain(fx.cut2InstallId);
    expect(idsAfter).toContain(fx.pinInstallId);

    // Launch-side: the authoritative launch re-validates through the SAME matrix
    // and refuses (PRECONDITION) BEFORE any worktree — no run, no workspace, the
    // attachment byte-identical. Parity holds: create-side and launch-side agree.
    await expect(
      launchRun(
        {
          taskId: "task-parity-1",
          packageVersions: { [fx.pinInstallId]: "try_once" },
        },
        ctx(),
        db as never,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    const runRows = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, "task-parity-1"));
    const workspaceRows = await db.select().from(schema.workspaces);

    expect(runRows).toHaveLength(0);
    expect(
      workspaceRows.filter((w: any) => w.projectId === project.id),
    ).toHaveLength(0);
    expect(addWorktreeMock).not.toHaveBeenCalled();
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });
});

describe("canonical pin consumer boundary matrix", () => {
  it("refuses unknown, removed and untrusted persisted installs with typed errors and no execution effects", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(
      project,
      "matrix-install",
      "flow-matrix-install",
    );
    const before = await attachmentRow(fx.attachmentId);

    const missing = resolvePinnedFlowRevisionForRefId(db, {
      flowRefId: "flow-matrix-install",
      packageInstallId: randomUUID(),
    });

    await expect(missing).rejects.toBeInstanceOf(MaisterError);
    await expect(missing).rejects.toMatchObject({ code: "CONFIG" });
    for (const patch of [
      { packageStatus: "Removed" as const },
      {
        packageStatus: "Installed" as const,
        trustStatus: "untrusted" as const,
      },
    ]) {
      await db
        .update(schema.packageInstalls)
        .set(patch)
        .where(eq(schema.packageInstalls.id, fx.cut2InstallId));
      await expect(
        resolvePinnedFlowRevisionForRefId(db, {
          flowRefId: "flow-matrix-install",
          packageInstallId: fx.cut2InstallId,
        }),
      ).rejects.toMatchObject({ name: "MaisterError", code: "PRECONDITION" });
    }
    await testDatabase.pool.query(
      "UPDATE package_installs SET package_status='Installed',trust_status='pending' WHERE id=$1",
      [fx.cut2InstallId],
    );
    await expect(
      resolvePinnedFlowRevisionForRefId(db, {
        flowRefId: "flow-matrix-install",
        packageInstallId: fx.cut2InstallId,
      }),
    ).rejects.toMatchObject({ name: "MaisterError", code: "PRECONDITION" });
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
    expect(
      await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.projectId, project.id)),
    ).toEqual([]);
    expect(addWorktreeMock).not.toHaveBeenCalled();
  });

  it("canonical try_once preserves schema, engine, setup and project enablement gates before any checkout or Run", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(
      project,
      "matrix-revision",
      "flow-matrix-revision",
    );
    const revision = await revisionOfInstall(
      fx.cut2InstallId,
      "flow-matrix-revision",
    );
    const taskId = randomUUID();

    await seedTask(taskId, project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    for (const [patch, code] of [
      [{ schemaVersion: 999 }, "CONFIG"],
      [{ engineMin: "999.0.0" }, "CONFIG"],
      [{ setupStatus: "pending" }, "PRECONDITION"],
      [{ setupStatus: "failed" }, "PRECONDITION"],
    ] as const) {
      await db
        .update(schema.flowRevisions)
        .set(patch)
        .where(eq(schema.flowRevisions.id, revision.id));
      await expect(
        launchRun(
          { taskId, packageVersions: { [fx.pinInstallId]: "try_once" } },
          ctx(),
          db,
        ),
      ).rejects.toMatchObject({ code });
      await db
        .update(schema.flowRevisions)
        .set({
          schemaVersion: revision.schemaVersion,
          engineMin: revision.engineMin,
          setupStatus: revision.setupStatus,
        })
        .where(eq(schema.flowRevisions.id, revision.id));
    }
    await db
      .update(schema.flows)
      .set({ enablementState: "Disabled" })
      .where(eq(schema.flows.id, fx.flowRowId));
    await expect(
      launchRun(
        { taskId, packageVersions: { [fx.pinInstallId]: "try_once" } },
        ctx(),
        db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(
      await db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.projectId, project.id)),
    ).toEqual([]);
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
    expect(addWorktreeMock).not.toHaveBeenCalled();
  });

  it("a real controlled recipe binds an upstream revision without attaching its install and retains the project's pin", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(
      project,
      "matrix-local",
      "flow-matrix-upstream",
    );
    const upstreamInstallId = await installSource(
      "matrix-upstream",
      "flow-matrix-upstream",
    );
    const upstream = await revisionOfInstall(
      upstreamInstallId,
      "flow-matrix-upstream",
    );
    const taskId = randomUUID();

    await seedTask(taskId, project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);
    const launched = await launchEvaluationEngineFixture(
      db,
      { taskId, flowRevisionId: upstream.id },
      ctx(),
    );
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, launched.runId));

    expect(run.flowRevisionId).toBe(upstream.id);
    expect(run.flowRevision).toBe(upstream.resolvedRevision);
    expect(run.flowVersion).toBe(upstream.versionLabel);
    expect(
      await db
        .select()
        .from(schema.projectPackageAttachments)
        .where(
          and(
            eq(schema.projectPackageAttachments.projectId, project.id),
            eq(
              schema.projectPackageAttachments.packageInstallId,
              upstreamInstallId,
            ),
          ),
        ),
    ).toEqual([]);
    expect(await attachmentRow(fx.attachmentId)).toEqual(before);
  });
});

it("retains a completed scheduled package adoption when a later admission gate refuses execution", async () => {
  const project = await createProject();
  const fx = await forkAttachWithNewerCut(
    project,
    "scheduled-adopt",
    "flow-scheduled-adopt",
  );
  const taskId = randomUUID();
  const now = new Date();

  await seedTask(taskId, project.id, fx.flowRowId);
  const created = await createScheduledLaunch({
    projectId: project.id,
    taskId,
    actorUserId: userId,
    idempotencyKey: randomUUID(),
    scheduledLocalTime: new Date(now.getTime() - 60_000)
      .toISOString()
      .slice(0, 16),
    timezone: "UTC",
    now: new Date(now.getTime() - 3600_000),
    launchRequest: {
      flowId: fx.flowRowId,
      packageVersions: { [fx.pinInstallId]: "adopt" },
    },
    db,
  });
  const claim = await claimScheduledLaunch({
    scheduledLaunchId: created.intent.id,
    projectId: project.id,
    source: "tick",
    now,
    db,
  });

  await testDatabase.pool.query(
    `CREATE FUNCTION pause_after_fixture_package_adoption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${fx.attachmentId}' AND NEW.package_install_id IS DISTINCT FROM OLD.package_install_id THEN UPDATE tasks SET queue_paused=true WHERE id='${taskId}'; END IF; RETURN NEW; END $$`,
  );
  await testDatabase.pool.query(
    `CREATE TRIGGER pause_after_fixture_package_adoption AFTER UPDATE ON project_package_attachments FOR EACH ROW EXECUTE FUNCTION pause_after_fixture_package_adoption()`,
  );
  try {
    expect(
      await dispatchClaimedScheduledLaunch({
        projectId: project.id,
        ...claim,
        now,
        db,
      }),
    ).toEqual({ state: "Failed" });
  } finally {
    await testDatabase.pool.query(
      `DROP TRIGGER pause_after_fixture_package_adoption ON project_package_attachments`,
    );
    await testDatabase.pool.query(
      `DROP FUNCTION pause_after_fixture_package_adoption()`,
    );
  }
  expect((await attachmentRow(fx.attachmentId)).packageInstallId).toBe(
    fx.cut2InstallId,
  );
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId));

  expect(task.queuePaused).toBe(true);
  expect(
    await db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId)),
  ).toEqual([]);
  expect(
    await db
      .select()
      .from(schema.taskLaunchIntents)
      .where(eq(schema.taskLaunchIntents.taskId, taskId)),
  ).toEqual([]);
  expect(addWorktreeMock).not.toHaveBeenCalled();
});
