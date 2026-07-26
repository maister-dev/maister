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
  };
});
vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: (input: unknown) => addWorktreeMock(input),
    removeWorktree: (input: unknown) => removeWorktreeMock(input),
    listBranches: async () => ["main", "develop"],
    resolveBaseCommit: async () => "feedface00000000000000000000000000000000",
    listRemoteUrls: async () => [],
  };
});
// Keep launched runs Pending — no scheduler slot, no runner spawn.
vi.mock("@/lib/scheduler", () => ({
  tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
}));

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
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
import { launchRun } from "@/lib/services/runs";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgresTestDb["container"];
let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let runtimeRootDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let originalRuntimeRoot: string | undefined;
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

  homeDir = await mkdtemp(join(tmpdir(), "launchpin-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
  runtimeRootDir = await mkdtemp(join(tmpdir(), "launchpin-int-rt-"));
  originalRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
  process.env.MAISTER_RUNTIME_ROOT = runtimeRootDir;

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "Pin Author" });
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
  if (originalRuntimeRoot === undefined)
    delete process.env.MAISTER_RUNTIME_ROOT;
  else process.env.MAISTER_RUNTIME_ROOT = originalRuntimeRoot;
  await closeDb();
  await testDatabase?.stop();
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

  await mkdir(repoPath, { recursive: true });
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id,
    slug,
    name: `Pin Proj ${slug}`,
    repoPath,
  });

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
  it("a pinned launch snapshots the pinned revision and leaves the attachment byte-identical", async () => {
    const project = await createProject();
    const fx = await forkAttachWithNewerCut(project, "pinpkg", "flow-pin");

    await seedTask("task-pin-1", project.id, fx.flowRowId);
    const before = await attachmentRow(fx.attachmentId);

    const result = await launchRun(
      {
        taskId: "task-pin-1",
        packagePin: { packageInstallId: fx.cut2InstallId },
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
      launchRun(
        {
          taskId: "task-refuse-1",
          packagePin: { packageInstallId: strangerInstallId },
        },
        ctx(),
        db as never,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

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

    const result = await launchRun(
      { taskId: "task-evalpin-1", evaluationFlowRevisionId: pinned.id },
      ctx(),
      db as never,
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
      launchRun(
        {
          taskId: "task-evalforeign-1",
          evaluationFlowRevisionId: foreign.id,
        },
        ctx(),
        db as never,
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

    const result = await launchRun(
      {
        taskId: "task-evalform-1",
        evaluationFormInputs: {
          environment: "staging",
          notes: "controlled run",
          unknownField: "not declared by the node",
        },
      },
      ctx(),
      db as never,
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
          packagePin: { packageInstallId: fx.cut2InstallId },
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
