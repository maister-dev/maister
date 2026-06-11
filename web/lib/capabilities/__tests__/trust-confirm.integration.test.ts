/**
 * T2.5 — confirmCapabilityTrust: R-2PC retry-safe trust confirmation (M14).
 *
 * The service behind POST /api/projects/[slug]/capabilities/[refId]/trust.
 *  - untrusted + setup.sh pending → confirm writes trusted, runs setup → done;
 *    a re-confirm after done → CONFLICT (409, nothing to do)
 *  - setup.sh fails → FLOW_INSTALL (502); row stays trusted+failed; a re-confirm
 *    re-runs setup (no spurious 409 — setupStatus is the idempotency marker)
 *  - no setup.sh (not_required) → CONFLICT (nothing to gate)
 *  - unknown ref → PRECONDITION
 */
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  confirmCapabilityTrust,
  installCapabilityRevision,
} from "@/lib/capabilities/import";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;
const execFile = promisify(execFileCb);

async function gitRun(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function buildFixture(
  parentDir: string,
  name: string,
  setup: "ok" | "fail" | "none",
): Promise<string> {
  const repoDir = join(parentDir, name);

  await mkdir(repoDir, { recursive: true });
  await gitRun(repoDir, ["init", "-q"]);
  await gitRun(repoDir, ["checkout", "-q", "-b", "main"]);
  await writeFile(join(repoDir, "README.md"), `# ${name}\n`);

  if (setup !== "none") {
    await writeFile(
      join(repoDir, "setup.sh"),
      `#!/usr/bin/env bash\necho "ran" > ./sentinel.txt\nexit ${setup === "ok" ? 0 : 1}\n`,
    );
    await chmod(join(repoDir, "setup.sh"), 0o755);
  }

  await gitRun(repoDir, ["add", "."]);
  await gitRun(repoDir, ["commit", "-q", "-m", "init"]);
  await gitRun(repoDir, ["tag", "v1.0.0"]);

  return repoDir;
}

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let fixturesDir: string;
let originalHome: string | undefined;
let projectId: string;
let repoOk: string;
let repoFail: string;
let repoNone: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cap_trust_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = join(tmpdir(), `cap-trust-home-${randomUUID()}`);
  fixturesDir = join(tmpdir(), `cap-trust-fixtures-${randomUUID()}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  repoOk = await buildFixture(fixturesDir, "cap-ok", "ok");
  repoFail = await buildFixture(fixturesDir, "cap-fail", "fail");
  repoNone = await buildFixture(fixturesDir, "cap-none", "none");

  projectId = randomUUID();
  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "cap-trust-proj",
    name: "Cap Trust",
    repoPath: fixturesDir,
    maisterYamlPath: join(fixturesDir, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

// Install then force untrusted+pending to model a third-party source awaiting
// an explicit operator confirmation.
async function installUntrusted(
  source: string,
  refId: string,
): Promise<{ importRowId: string; installedPath: string }> {
  const installed = await installCapabilityRevision({
    source,
    version: "v1.0.0",
    capabilityRefId: refId,
    projectId,
    db,
  });

  if (installed.setupStatus === "pending") {
    await db
      .update(schema.capabilityImports)
      .set({ trustStatus: "untrusted" })
      .where(eq(schema.capabilityImports.id, installed.importRowId));
  }

  return installed;
}

describe("confirmCapabilityTrust", () => {
  it("untrusted+pending → confirm writes trusted, runs setup → done; re-confirm → CONFLICT", async () => {
    const installed = await installUntrusted(repoOk, "trust-ok");

    const result = await confirmCapabilityTrust({
      projectId,
      capabilityRefId: "trust-ok",
      db,
    });

    expect(result).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "done",
    });

    const sentinel = join(installed.installedPath, "sentinel.txt");

    expect((await stat(sentinel)).isFile()).toBe(true);

    const rows = await db
      .select({
        trustStatus: schema.capabilityImports.trustStatus,
        setupStatus: schema.capabilityImports.setupStatus,
      })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "done",
    });

    // Re-confirm after done → nothing to do → CONFLICT (409).
    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-ok",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFLICT");
  });

  it("setup.sh failure → FLOW_INSTALL, row stays trusted+failed, re-confirm re-runs (no spurious 409)", async () => {
    const installed = await installUntrusted(repoFail, "trust-fail");

    let first: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-fail",
        db,
      });
    } catch (e) {
      first = e;
    }

    expect(isMaisterError(first)).toBe(true);
    expect((first as { code: string }).code).toBe("FLOW_INSTALL");

    const rows = await db
      .select({
        trustStatus: schema.capabilityImports.trustStatus,
        setupStatus: schema.capabilityImports.setupStatus,
      })
      .from(schema.capabilityImports)
      .where(eq(schema.capabilityImports.id, installed.importRowId));

    expect(rows[0]).toMatchObject({
      trustStatus: "trusted",
      setupStatus: "failed",
    });

    // Re-confirm: setupStatus=failed is NOT a terminal 409 state — it re-runs
    // setup (which fails again → FLOW_INSTALL, never CONFLICT).
    let second: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-fail",
        db,
      });
    } catch (e) {
      second = e;
    }

    expect(isMaisterError(second)).toBe(true);
    expect((second as { code: string }).code).toBe("FLOW_INSTALL");
  });

  it("no setup.sh (not_required) → CONFLICT (nothing to gate)", async () => {
    await installCapabilityRevision({
      source: repoNone,
      version: "v1.0.0",
      capabilityRefId: "trust-none",
      projectId,
      db,
    });

    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "trust-none",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("CONFLICT");
  });

  it("unknown ref → PRECONDITION", async () => {
    let caught: unknown;

    try {
      await confirmCapabilityTrust({
        projectId,
        capabilityRefId: "does-not-exist",
        db,
      });
    } catch (e) {
      caught = e;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("PRECONDITION");
  });
});
