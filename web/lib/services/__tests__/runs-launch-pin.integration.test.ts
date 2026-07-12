import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { gitCommitWorkingDir } from "@/lib/local-packages/git";
import {
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import { cutLocalPackageVersion } from "@/lib/local-packages/versions";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";
import { launchRun } from "@/lib/services/runs";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
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
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("launchpin_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "launchpin-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

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
  await closeDb();
  await pool?.end();
  await container?.stop();
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

// Fork a local package from an installed source, cut v1, attach to the
// project, cut v2 (the newer target) — the ADR-132 fixture chain.
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
  const sourceInstallId = await installSource(sourceName, flowId);
  const { localPackageId } = await forkPackageToLocal({
    sourceInstallId,
    sourceRef: sourceName,
    createdBy: userId,
    forceNew: true,
    db,
  });
  const pkg = await getLocalPackage(localPackageId, db);
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
  const freshPkg = await getLocalPackage(localPackageId, db);
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

async function attachmentRow(attachmentId: string): Promise<Record<string, unknown>> {
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
});
