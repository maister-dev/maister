import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The real selectPrAdapter throws PRECONDITION for the "generic" provider (a bare
// file remote) — the push-only path. Flip `mockState.mode = "succeed"` to make the
// adapter return a PR url, exercising the PR-success path without a real provider.
const mockState = vi.hoisted(() => ({ mode: "throw" as "throw" | "succeed" }));

vi.mock("@/lib/runs/pr-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/runs/pr-adapter")>();

  return {
    ...actual,
    selectPrAdapter: (provider: never, ctx: never) =>
      mockState.mode === "succeed"
        ? {
            preflight: async () => undefined,
            createOrUpdatePr: async () => ({
              url: "https://example.test/pr/7",
              number: 7,
            }),
          }
        : actual.selectPrAdapter(provider, ctx),
  };
});

import { closeDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  createLocalPackage,
  getLocalPackage,
} from "@/lib/local-packages/service";
import { gitCommitWorkingDir, gitHeadSha } from "@/lib/local-packages/git";
import { publishLocalPackage } from "@/lib/local-packages/publish";
import { writeWorkingDirFile } from "@/lib/local-packages/service";

const execFileAsync = promisify(execFile);
const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let homeDir: string;
let originalHome: string | undefined;
let originalDbUrl: string | undefined;
let userId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("publish_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool, { schema: schemaModule });
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "publish-int-home-"));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `u-${userId}@x.test`,
    name: "Publish Author",
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
  await rm(homeDir, { recursive: true, force: true });
});

async function makeBareRemote(): Promise<{
  sourceId: string;
  barePath: string;
}> {
  const barePath = await mkdtemp(join(tmpdir(), "publish-bare-"));

  await execFileAsync("git", ["init", "--bare", "-q", barePath]);
  const sourceId = randomUUID();

  await db.insert(schema.packageSources).values({
    id: sourceId,
    url: barePath,
    enabled: true,
  });

  return { sourceId, barePath };
}

async function makePackage(name: string): Promise<any> {
  const pkg = await createLocalPackage({ name, createdBy: userId, db });

  return (await getLocalPackage(pkg.id, db))!;
}

async function remoteBranchSha(
  barePath: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      barePath,
      "rev-parse",
      "--verify",
      branch,
    ]);

    return stdout.trim();
  } catch {
    return null;
  }
}

async function lpRow(id: string): Promise<any> {
  const [row] = await db
    .select()
    .from(schema.localPackages)
    .where(eq(schema.localPackages.id, id));

  return row;
}

describe("PR-to-source publish (integration)", () => {
  it("rejects a targetSourceId that is not a registered source with CONFLICT", async () => {
    const pkg = await makePackage("pub-reject");

    await expect(
      publishLocalPackage(pkg.id, {
        targetSourceId: "not-a-source",
        branchName: `maister/${pkg.slug}`,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );
  });

  it("pushes the package branch and falls back to push-only for an unsupported provider", async () => {
    mockState.mode = "throw";
    const { sourceId, barePath } = await makeBareRemote();
    const pkg = await makePackage("pub-pushonly");
    const branch = `maister/${pkg.slug}`;

    const result = await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });

    expect(result.pushed).toBe(true);
    expect(result.prUrl).toBeNull(); // generic provider → no PR
    expect(result.branch).toBe(branch);
    // The branch landed on the bare remote at the package's HEAD.
    expect(await remoteBranchSha(barePath, branch)).toBe(
      await gitHeadSha(pkg.workingDir),
    );
    // Two-phase: markers persisted after the push succeeded.
    const row = await lpRow(pkg.id);

    expect(row.lastPushedBranch).toBe(branch);
    expect(row.lastPrUrl).toBeNull();
  });

  it("stores the PR url when the provider adapter opens a PR", async () => {
    mockState.mode = "succeed";
    const { sourceId } = await makeBareRemote();
    const pkg = await makePackage("pub-pr");
    const branch = `maister/${pkg.slug}`;

    const result = await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });

    expect(result.prUrl).toBe("https://example.test/pr/7");
    expect((await lpRow(pkg.id)).lastPrUrl).toBe("https://example.test/pr/7");
    mockState.mode = "throw";
  });

  it("serializes concurrent publishes of the same package — the loser gets CONFLICT", async () => {
    mockState.mode = "throw";
    const a = await makeBareRemote();
    const b = await makeBareRemote();
    const pkg = await makePackage("pub-concurrent");
    const branch = `maister/${pkg.slug}`;

    const [r1, r2] = await Promise.allSettled([
      publishLocalPackage(pkg.id, {
        targetSourceId: a.sourceId,
        branchName: branch,
        db,
      }),
      publishLocalPackage(pkg.id, {
        targetSourceId: b.sourceId,
        branchName: branch,
        db,
      }),
    ]);

    // Exactly one wins; the other is refused with CONFLICT (publish in progress).
    expect([r1.status, r2.status].sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = (
      r1.status === "rejected" ? r1 : r2
    ) as PromiseRejectedResult;

    expect(isMaisterError(rejected.reason) && rejected.reason.code).toBe(
      "CONFLICT",
    );

    // Only the winner pushed — exactly one target carries the branch (no double-push
    // to the wrong remote), and the mutex is released afterwards.
    const headSha = await gitHeadSha(pkg.workingDir);
    const landed = [
      await remoteBranchSha(a.barePath, branch),
      await remoteBranchSha(b.barePath, branch),
    ].filter((s) => s === headSha);

    expect(landed).toHaveLength(1);
    expect((await lpRow(pkg.id)).publishingStartedAt).toBeNull();
  });

  it("a stale publish lock is reclaimable (a crashed publish never wedges)", async () => {
    mockState.mode = "throw";
    const { sourceId, barePath } = await makeBareRemote();
    const pkg = await makePackage("pub-stale");
    const branch = `maister/${pkg.slug}`;

    // Simulate a crashed publish: a lock left ~20 min ago (the TTL is 10 min).
    await db
      .update(schema.localPackages)
      .set({ publishingStartedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(schema.localPackages.id, pkg.id));

    // A fresh publish reclaims the stale lock and succeeds.
    const result = await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });

    expect(result.pushed).toBe(true);
    expect(await remoteBranchSha(barePath, branch)).toBe(
      await gitHeadSha(pkg.workingDir),
    );
    expect((await lpRow(pkg.id)).publishingStartedAt).toBeNull();
  });

  it("re-publish updates the SAME stable branch (fast-forward), never duplicating", async () => {
    mockState.mode = "throw";
    const { sourceId, barePath } = await makeBareRemote();
    const pkg = await makePackage("pub-republish");
    const branch = `maister/${pkg.slug}`;

    await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });
    const first = await remoteBranchSha(barePath, branch);

    // A new commit, then re-publish → the same branch advances (fast-forward).
    await writeWorkingDirFile(pkg, "rules/note.md", "updated\n");
    await gitCommitWorkingDir(pkg.workingDir, "edit");
    await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });

    const second = await remoteBranchSha(barePath, branch);

    expect(second).not.toBe(first);
    expect(second).toBe(await gitHeadSha(pkg.workingDir));
  });

  it("a non-fast-forward push → CONFLICT (two-phase: markers not updated on failure)", async () => {
    mockState.mode = "succeed"; // the successful publishes set last_pr_url
    const { sourceId } = await makeBareRemote();
    const pkg = await makePackage("pub-nonff");
    const branch = `maister/${pkg.slug}`;

    const firstSha = await gitHeadSha(pkg.workingDir);

    await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });

    await writeWorkingDirFile(pkg, "rules/note.md", "ahead\n");
    await gitCommitWorkingDir(pkg.workingDir, "ahead");
    await publishLocalPackage(pkg.id, {
      targetSourceId: sourceId,
      branchName: branch,
      db,
    });
    const prAfterSuccess = (await lpRow(pkg.id)).lastPrUrl;

    // Rewind the working dir BEHIND the remote, then publish → non-fast-forward.
    await execFileAsync("git", [
      "-C",
      pkg.workingDir,
      "reset",
      "--hard",
      firstSha,
    ]);
    mockState.mode = "throw";

    await expect(
      publishLocalPackage(pkg.id, {
        targetSourceId: sourceId,
        branchName: branch,
        db,
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isMaisterError(e) && e.code === "CONFLICT",
    );

    // The failed publish threw before the marker update — last_pr_url unchanged.
    expect((await lpRow(pkg.id)).lastPrUrl).toBe(prAfterSuccess);
  });
});
