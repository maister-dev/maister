/**
 * Integration tests for T-B3: exec_trust two-axis gate.
 *
 * (a) git trusted_by_policy install WITH setup.sh → setup RUNS at install
 *     (setupStatus='done', exec_trust='trusted', enablementState='Enabled')
 *     REGRESSION GUARD: verifies B2 did NOT silently skip setup.sh.
 *
 * (b) authored bridge (execTrustOverride='untrusted') WITH setup.sh →
 *     setup NOT run (setupStatus='pending', exec_trust='untrusted').
 *
 * (c) trustExecutable(...) flips exec_trust→'trusted' AND runs pending setup
 *     (setupStatus→'done').
 *
 * (d) enableRevision sets exec_trust='trusted' on the revision row inside
 *     the transaction.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFlowFixture } from "@/lib/__tests__/_fixtures/build-flow-plugin";
import * as schemaModule from "@/lib/db/schema";
import { installFlowPlugin } from "@/lib/flows";
import { trustExecutable } from "@/lib/flows/exec-trust";
import { enableRevision } from "@/lib/flows/lifecycle";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: any;
let homeDir: string;
let workspaceRoot: string;
let fixturesDir: string;
let setupOkRepo: string;
let projectId: string;
let originalHome: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("exec_trust_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  homeDir = await mkdtemp(join(tmpdir(), "exec-trust-home-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "exec-trust-ws-"));
  fixturesDir = await mkdtemp(join(tmpdir(), "exec-trust-fixtures-"));

  originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  setupOkRepo = await buildFlowFixture(fixturesDir, "with-setup-ok");

  projectId = randomUUID();
  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: "exec-trust-proj",
    name: "Exec Trust Test",
    repoPath: workspaceRoot,
    maisterYamlPath: join(workspaceRoot, "maister.yaml"),
  });
}, 180_000);

afterAll(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  await pool?.end();
  await container?.stop();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(fixturesDir, { recursive: true, force: true });
});

describe("exec_trust two-axis gate (T-B3)", () => {
  it("(a) [REGRESSION] git trusted_by_policy install WITH setup.sh: setup RUNS, exec_trust='trusted', setupStatus='done', enablementState='Enabled'", async () => {
    const result = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "exec-trust-proj",
      flowId: "setup-ok-trusted",
      workspaceRoot,
      db,
    });

    // enablementState must be 'Enabled' — setup.sh exit 0 on a trusted source.
    expect(result.enablementState).toBe("Enabled");

    // Sentinel written by setup.sh must exist on disk (proves setup.sh ran).
    const sentinelPath = join(result.installedPath, ".maister-setup-done");
    const sentinelStat = await stat(sentinelPath);

    expect(sentinelStat.isFile()).toBe(true);

    // DB: exec_trust='trusted', setupStatus='done'.
    const [revRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, result.revisionId));

    expect(revRow.execTrust).toBe("trusted");
    expect(revRow.setupStatus).toBe("done");
  }, 60_000);

  it("(b) execTrustOverride=untrusted WITH setup.sh: setup NOT run, exec_trust='untrusted', setupStatus='pending'", async () => {
    // installAuthoredFlowPackageBridge always sets execTrustOverride='untrusted'.
    // Test that path directly via installFlowPlugin (which passes execTrustOverride
    // to installFlowPluginImpl). The local abs path resolves trusted_by_policy,
    // but exec-trust must still be suppressed by the override.
    const result = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "exec-trust-proj",
      flowId: "setup-ok-authored",
      workspaceRoot,
      db,
      execTrustOverride: "untrusted",
    });

    // DB: exec_trust='untrusted', setupStatus='pending'.
    const [revRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, result.revisionId));

    expect(revRow.execTrust).toBe("untrusted");
    expect(revRow.setupStatus).toBe("pending");

    // enablementState must be 'Enabled' (exec-untrusted authored path: auto-enable
    // without setup.sh).
    expect(result.enablementState).toBe("Enabled");
  }, 60_000);

  it("(c) trustExecutable flips exec_trust→'trusted' and runs pending setup (setupStatus→'done')", async () => {
    // Install with execTrustOverride='untrusted' so setupStatus stays pending.
    const install = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "exec-trust-proj",
      flowId: "setup-ok-trust-flip",
      workspaceRoot,
      db,
      execTrustOverride: "untrusted",
    });

    // Pre-condition: exec_trust='untrusted', setupStatus='pending'.
    const [beforeRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, install.revisionId));

    expect(beforeRow.execTrust).toBe("untrusted");
    expect(beforeRow.setupStatus).toBe("pending");

    // Call trustExecutable → must flip exec_trust and run setup.sh.
    // trustExecutable uses flows.id (the row UUID), not flowRefId.
    const trustResult = await trustExecutable({
      projectId,
      flowId: install.flowRowId,
      db,
    });

    expect(trustResult.execTrust).toBe("trusted");
    expect(trustResult.setupStatus).toBe("done");

    // DB: verify persisted.
    const [afterRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, install.revisionId));

    expect(afterRow.execTrust).toBe("trusted");
    expect(afterRow.setupStatus).toBe("done");
  }, 60_000);

  it("(d) enableRevision sets exec_trust='trusted' on the revision row", async () => {
    // Install as untrusted (so exec_trust starts as untrusted).
    const install = await installFlowPlugin({
      source: setupOkRepo,
      version: "v1.0.0",
      projectId,
      projectSlug: "exec-trust-proj",
      flowId: "setup-ok-enable-flip",
      workspaceRoot,
      db,
    });

    // Manually reset exec_trust to 'untrusted' + packageStatus to 'Installed'
    // to simulate a freshly-installed-but-not-yet-trusted revision,
    // so enableRevision has something to flip.
    await db
      .update(schema.flowRevisions)
      .set({ execTrust: "untrusted" })
      .where(eq(schema.flowRevisions.id, install.revisionId));

    // enableRevision requires trustStatus != 'untrusted' on the flows row.
    // The install above uses a local abs path → trusted_by_policy.
    // Also reset the flows row enabledRevisionId to null so enableRevision
    // can re-enable it (it requires packageStatus='Installed').
    await db
      .update(schema.flowRevisions)
      .set({ packageStatus: "Installed" })
      .where(eq(schema.flowRevisions.id, install.revisionId));

    await enableRevision({
      projectId,
      flowRefId: "setup-ok-enable-flip",
      revisionId: install.revisionId,
      db,
    });

    const [afterRow] = await db
      .select()
      .from(schema.flowRevisions)
      .where(eq(schema.flowRevisions.id, install.revisionId));

    expect(afterRow.execTrust).toBe("trusted");
  }, 60_000);
});
