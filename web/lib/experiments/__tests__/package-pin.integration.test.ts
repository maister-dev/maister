import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ADR-129 Phase-3 capstone (acceptance 1/2/3 + the T9 join): a REAL
// fork-vs-upstream experiment on real Postgres — upstream install → attach →
// fork → edit → commit → cut → experiment A=upstream / B=fork-cut → launch
// both → same pinned base commit, different snapshotted flow revisions, both
// provenances in the comparison DTO, byte-identical attachment, and member
// runs invisible to the auto-promotion sweep.

const execFileAsync = promisify(execFile);

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

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: () => checkSupervisorHealthMock(),
  };
});
// Worktree side effects are mocked; assertBaseCommitReachable and
// resolveBaseCommit run REAL git against the fixture project repo.
vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    addWorktree: vi.fn(async () => undefined),
    removeWorktree: vi.fn(async () => undefined),
    listBranches: async () => ["main", "develop"],
    listRemoteUrls: async () => [],
  };
});
vi.mock("@/lib/scheduler", () => ({
  tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
}));

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { getExperimentComparison } from "@/lib/experiments/comparison";
import { launchExperimentVariants } from "@/lib/experiments/launch";
import { createExperiment } from "@/lib/experiments/service";
import { forkPackageToLocal } from "@/lib/local-packages/fork";
import { gitCommitWorkingDir } from "@/lib/local-packages/git";
import {
  getLocalPackage,
  writeWorkingDirFile,
} from "@/lib/local-packages/service";
import { cutLocalPackageVersion } from "@/lib/local-packages/versions";
import { attachPackage, installPackageRevision } from "@/lib/packages/attach";
import { runAutoPromoteJob } from "@/lib/scheduler/handlers/auto-promote";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let userId: string;

const FLOW_ID = "flow-exp";

const FLOW_YAML = (marker: string): string =>
  [
    "schemaVersion: 1",
    `name: ${FLOW_ID}`,
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

const MANIFEST = `schemaVersion: 1\nname: exppkg\nflows:\n  - { id: ${FLOW_ID}, path: flows/${FLOW_ID} }\ncapabilities: []\n`;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("exp_pin_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "exp-pin-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: `u-${userId}@x.test`, name: "Exp Author" });
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

describe("fork-vs-upstream experiment (integration, real Postgres + git)", () => {
  it("A=upstream / B=fork-cut launch from one base commit with per-variant provenance and an untouched attachment", async () => {
    // Project repo: a REAL git repo (base-commit pinning runs real git).
    const projectId = randomUUID();
    const slug = `exp-${projectId.slice(0, 8)}`;
    const repoPath = join(homeDir, `repo-${projectId.slice(0, 8)}`);

    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ["init", "-b", "main"]);
    await writeFile(join(repoPath, "README.md"), "hello\n");
    await git(repoPath, ["add", "-A"]);
    await git(repoPath, [
      "-c",
      "user.email=t@t.test",
      "-c",
      "user.name=T",
      "commit",
      "-m",
      "init",
    ]);
    await db.insert(schema.projects).values({
      taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug,
      name: `Exp Proj ${slug}`,
      repoPath,
    });

    // Upstream package install → attach (the project pin).
    const pkgDir = await mkdtemp(join(tmpdir(), "exp-pin-pkg-"));

    await mkdir(join(pkgDir, `flows/${FLOW_ID}`), { recursive: true });
    await writeFile(join(pkgDir, `flows/${FLOW_ID}/flow.yaml`), FLOW_YAML("v1"));
    await writeFile(join(pkgDir, "maister-package.yaml"), MANIFEST);
    const upstream = await installPackageRevision({
      source: pkgDir,
      version: "exppkg/v1.0.0",
      trustStatus: "trusted_by_policy",
      db,
    });

    await rm(pkgDir, { recursive: true, force: true });
    const attached = await attachPackage({
      projectId,
      projectSlug: slug,
      packageInstallId: upstream.id,
      workspaceRoot: repoPath,
      db,
    });

    // Fork → edit → commit → cut (a DIFFERENT digest than upstream).
    const { localPackageId } = await forkPackageToLocal({
      sourceInstallId: upstream.id,
      sourceRef: "exppkg",
      createdBy: userId,
      forceNew: true,
      db,
    });
    const pkg = await getLocalPackage(localPackageId, db);

    await writeWorkingDirFile(
      pkg!,
      `flows/${FLOW_ID}/flow.yaml`,
      FLOW_YAML("v2-fork"),
    );
    await gitCommitWorkingDir(pkg!.workingDir, "fork edit");
    const cut = await cutLocalPackageVersion(pkg!, { db });

    // The attached flow row backs the task.
    const [flowRow] = await db
      .select()
      .from(schema.flows)
      .where(
        and(
          eq(schema.flows.projectId, projectId),
          eq(schema.flows.flowRefId, FLOW_ID),
        ),
      );
    const taskId = randomUUID();

    await db.insert(schema.tasks).values({
      number: 1,
      id: taskId,
      projectId,
      title: "compare fork vs upstream",
      prompt: "do it",
      flowId: flowRow!.id as string,
    });

    const attachmentBefore = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.id, attached!.attachmentId));

    // Create the experiment: A pins the upstream install, B pins the cut.
    const experiment = await createExperiment(
      {
        projectId,
        slug,
        actorUserId: userId,
        input: {
          taskId,
          title: "fork vs upstream",
          baseBranch: "main",
          variants: [
            {
              key: "upstream",
              label: "Upstream",
              config: { packagePin: { packageInstallId: upstream.id } },
            },
            {
              key: "fork",
              label: "Fork cut",
              config: { packagePin: { packageInstallId: cut.installId } },
            },
          ],
        },
      },
      db as never,
    );

    const launch = await launchExperimentVariants(
      {
        projectId,
        experimentId: experiment.id,
        actorUserId: userId,
        input: { variants: "all", replicates: 1 },
      },
      db as never,
    );

    expect(launch.outcomes).toHaveLength(2);

    const runRows = (await db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.taskId, taskId))) as Array<Record<string, any>>;
    const workspaceRows = (await db
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.projectId, projectId))) as Array<
      Record<string, any>
    >;

    expect(runRows).toHaveLength(2);
    // Same pinned base commit on both variants' workspaces.
    expect(
      new Set(workspaceRows.map((row) => String(row.baseCommit))),
    ).toEqual(new Set([experiment.baseCommit]));
    // Different snapshotted flow revisions (the whole point of the axis).
    const revisionIds = new Set(
      runRows.map((row) => String(row.flowRevisionId)),
    );

    expect(revisionIds.size).toBe(2);

    // Attachment byte-identical before/after both launches.
    const attachmentAfter = await db
      .select()
      .from(schema.projectPackageAttachments)
      .where(eq(schema.projectPackageAttachments.id, attached!.attachmentId));

    expect(attachmentAfter).toEqual(attachmentBefore);

    // Comparison DTO carries both provenances + the revision delta marker.
    const comparison = await getExperimentComparison(
      {
        projectId,
        experimentId: experiment.id,
        viewerType: "session",
      },
      db as never,
    );
    const byVariant = new Map(
      comparison.runs.map((run) => [run.variantKey, run.provenance]),
    );

    expect(comparison.flowRevisionDelta).toBe(true);
    expect(byVariant.get("upstream")).toMatchObject({
      packageName: "exppkg",
      kind: "upstream",
      versionLabel: "exppkg/v1.0.0",
    });
    expect(byVariant.get("fork")).toMatchObject({
      packageName: "exppkg",
      kind: "local_cut",
      versionLabel: cut.versionLabel,
    });

    // T9 join: flip both members to Review in an auto-promotion-enabled
    // project — the sweep must never see them as candidates.
    await db
      .update(schema.projects)
      .set({
        autoPromotion: {
          enabled: true,
          lanes: (await import("@/lib/auto-promotion/config")).BUILT_IN_LANES,
        },
      })
      .where(eq(schema.projects.id, projectId));
    for (const row of runRows) {
      await db
        .update(schema.runs)
        .set({
          status: "Review",
          reviewEnteredAt: new Date(Date.now() - 30 * 60_000),
        })
        .where(eq(schema.runs.id, String(row.id)));
    }
    const promoteMock = vi.fn(async () => ({}));
    const summary = await runAutoPromoteJob({
      db: db as never,
      promote: promoteMock as never,
    });

    expect(summary.candidates).toBe(0);
    expect(promoteMock).not.toHaveBeenCalled();
  }, 120_000);
});
