import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { projects, platformAcpRunners } from "@/lib/db/schema";
import { readExportSnapshot } from "@/lib/project-config-persistence/projection";
import { previewProjectConfiguration } from "@/lib/project-config-persistence/service";
import { transitionConfigOperation } from "@/lib/project-config-persistence/store";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: async () => ({ id: "usr_bootstrap_admin" }),
  requireProjectAction: async () => undefined,
}));
const { PATCH: aggregate } =
  await import("@/app/api/projects/[slug]/settings/route");
const { PATCH: dedicated } =
  await import("@/app/api/projects/[slug]/settings/runner/route");
const exec = promisify(execFile);
const projectId = randomUUID();
const runnerId = randomUUID();
const slug = `cpc-${projectId}`;
let repo: string;
let fingerprint: string[];

async function git(...args: string[]): Promise<string> {
  return (await exec("git", ["-C", repo, ...args])).stdout;
}
async function state(): Promise<string[]> {
  return Promise.all([
    readFile(join(repo, "maister.yaml"), "utf8"),
    git("rev-parse", "HEAD"),
    git("ls-files", "--stage", "-v"),
    git("status", "--porcelain=v1", "--untracked-files=all"),
  ]);
}
async function patch(
  route: typeof aggregate,
  body:
    | { runnerId: string | null }
    | { syncStrategyDefault: "merge" }
    | { taskQualificationPolicy: "legacy" | "required" | null },
): Promise<Response> {
  return route(
    new NextRequest(`http://t/api/projects/${slug}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}
beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "config_runner_routes",
  });
  repo = await mkdtemp(join(tmpdir(), "config-runner-"));
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await writeFile(
    join(repo, "maister.yaml"),
    `schemaVersion: 2\nproject:\n  name: Runner\nflows: []\n`,
  );
  await git("add", "maister.yaml");
  await git("commit", "-m", "initial");
  fingerprint = await state();
  await database.db.insert(projects).values({
    id: projectId,
    slug,
    name: "Runner",
    repoPath: repo,
    maisterYamlPath: join(repo, "maister.yaml"),
    taskKey: `R${projectId.slice(0, 8).toUpperCase()}`,
  });
  await database.db
    .insert(platformAcpRunners)
    .values(
      testPlatformRunnerRow(
        runnerId,
        "claude",
      ) as typeof platformAcpRunners.$inferInsert,
    );
}, 180_000);
afterAll(async () => {
  await database?.stop();
  if (repo) await rm(repo, { recursive: true, force: true });
});

it("IT-CPC-01: both runner APIs SET/CLEAR/SET the exportable runtime value without modifying Git; DB-only settings do not advance export revision", async () => {
  let revision = 0n;

  for (const route of [aggregate, dedicated]) {
    for (const selected of [runnerId, null, runnerId]) {
      const before = await readExportSnapshot(database.db, projectId);
      const response = await patch(route, { runnerId: selected });

      expect(response.status).toBe(200);
      const after = await readExportSnapshot(database.db, projectId);

      if (before.projection.defaultRunnerId !== selected) revision++;
      expect(after.projection.defaultRunnerId).toBe(selected);
      expect(after.exportRevision).toBe(revision.toString());
      expect(await state()).toEqual(fingerprint);
    }
  }
  const before = await readExportSnapshot(database.db, projectId);

  expect(
    (await patch(aggregate, { syncStrategyDefault: "merge" })).status,
  ).toBe(200);
  expect(
    (await readExportSnapshot(database.db, projectId)).exportRevision,
  ).toBe(before.exportRevision);
  expect(await state()).toEqual(fingerprint);
});

it("IT-UX-18: qualification policy SET/CLEAR/SET updates reviewed export and retains its baseline", async () => {
  for (const mode of ["required", null, "required"] as const) {
    const before = await readExportSnapshot(database.db, projectId);
    const response = await patch(aggregate, { taskQualificationPolicy: mode });

    expect(response.status).toBe(200);
    expect((await response.json()).taskQualificationPolicy).toEqual({
      version: 1,
      baseline: "legacy",
      override: mode,
      mode: mode ?? "legacy",
    });
    const after = await readExportSnapshot(database.db, projectId);

    expect(after.projection.taskQualificationOverride).toBe(mode);
    expect(BigInt(after.exportRevision)).toBe(
      BigInt(before.exportRevision) + 1n,
    );
    expect(await state()).toEqual(fingerprint);
  }
});

it("IT-CPC-09: both runner APIs report the active publication guard as actionable 409 and leave runtime state unchanged", async () => {
  const preview = await previewProjectConfiguration(
    database.db,
    projectId,
    "usr_bootstrap_admin",
  );

  expect(preview.kind).toBe("ready");
  if (preview.kind !== "ready")
    throw new Error("Expected changed runner review");
  const identity = {
    id: preview.previewId,
    projectId,
    actorUserId: "usr_bootstrap_admin",
  };
  const token = randomUUID();

  await transitionConfigOperation(
    database.db,
    identity,
    { state: "previewed", ownerToken: null },
    { state: "preparing", ownerToken: token, acceptedAt: new Date() },
  );
  try {
    for (const route of [aggregate, dedicated]) {
      const response = await patch(route, { runnerId: null });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "CONFLICT",
        details: { reason: "operation_busy" },
      });
    }
    expect(
      (await patch(aggregate, { taskQualificationPolicy: null })).status,
    ).toBe(409);
    const [row] = await database.db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));

    expect(row.defaultRunnerId).toBe(runnerId);
    expect(await state()).toEqual(fingerprint);
  } finally {
    await transitionConfigOperation(
      database.db,
      identity,
      { state: "preparing", ownerToken: token },
      {
        state: "failed",
        completedAt: new Date(),
        errorReason: "commit_failed",
      },
    );
  }
});
