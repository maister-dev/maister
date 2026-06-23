// ADR-089 rework: the agents catalog is a projection of INSTALLED flow
// revisions — `agents/<stem>.md` files register under package-qualified ids
// `<flowRefId>:<stem>`. These tests drive registerAgentsForRevision/
// resyncAgents against real installed-dir fixtures on a real Postgres.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerAgentsForRevision, resyncAgents } from "@/lib/agents/registry";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-agent-pkgs-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
});

function definitionMd(opts?: {
  runner?: string | null;
  workspaceRef?: string;
  recommendedCron?: { expr: string; timezone: string };
}): string {
  const runnerLine = opts?.runner ? `runner: ${opts.runner}\n` : "";
  const refLine = opts?.workspaceRef
    ? `workspace_ref: ${opts.workspaceRef}\n`
    : "";
  const recommended = opts?.recommendedCron
    ? `recommended:\n  cron:\n    expr: "${opts.recommendedCron.expr}"\n    timezone: ${opts.recommendedCron.timezone}\n`
    : "";

  return `---
name: Triager
description: Classifies tasks
${runnerLine}workspace: ${opts?.workspaceRef ? "repo_read" : "none"}
${refLine}mode: session
triggers:
  - manual
risk_tier: read_only
${recommended}---
Triage the task.
`;
}

// An installed flow-revision fixture: a real dir with maister-agents/*.md + the
// flow_revisions row pointing at it.
async function installRevisionFixture(opts: {
  flowRefId: string;
  versionLabel: string;
  agents: Record<string, string>;
  source?: string;
  packageStatus?: string;
  installedAt?: Date;
}): Promise<string> {
  const revisionId = randomUUID();
  const installedPath = path.join(
    cacheRoot,
    `${opts.flowRefId}@${opts.versionLabel}-${revisionId.slice(0, 8)}`,
  );

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  for (const [stem, content] of Object.entries(opts.agents)) {
    await writeFile(
      path.join(installedPath, "maister-agents", `${stem}.md`),
      content,
      "utf8",
    );
  }

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path",
        "package_status", "installed_at")
     VALUES ($1, $2, $3, $4, $5, 'digest', '{}'::jsonb, 1, $6, $7, $8)`,
    [
      revisionId,
      opts.flowRefId,
      opts.source ?? "github.com/acme/pkg",
      opts.versionLabel,
      `rev-${opts.versionLabel}`,
      installedPath,
      opts.packageStatus ?? "Installed",
      opts.installedAt ?? new Date(),
    ],
  );

  return revisionId;
}

async function agentRow(
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id));

  return rows[0] as Record<string, unknown> | undefined;
}

describe("registerAgentsForRevision", () => {
  it("registers package agents under qualified ids with provenance", async () => {
    const revisionId = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      agents: { triager: definitionMd() },
    });

    const summary = await registerAgentsForRevision(revisionId, db);

    expect(summary.registered).toEqual(["aif:triager"]);
    expect(summary.invalid).toEqual([]);

    const row = await agentRow("aif:triager");

    expect(row).toMatchObject({
      id: "aif:triager",
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Triager",
      workspace: "none",
      enabled: true,
    });
    expect(String(row?.sourcePath)).toContain("/maister-agents/triager.md");
  });

  it("derives origin=authored for local filesystem sources", async () => {
    const revisionId = await installRevisionFixture({
      flowRefId: "studio-pkg",
      versionLabel: "local-abc123",
      source: "/var/folders/authored-bridge-tmp",
      agents: { helper: definitionMd() },
    });

    await registerAgentsForRevision(revisionId, db);

    expect((await agentRow("studio-pkg:helper"))?.origin).toBe("authored");
  });

  it("SET/CLEAR-syncs every parsed column on re-register (upgrade path)", async () => {
    await pool.query(
      `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider")
       VALUES ('claude-default', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb)
       ON CONFLICT DO NOTHING`,
    );

    const v1 = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      agents: {
        triager: definitionMd({
          runner: "claude-default",
          workspaceRef: "trigger",
        }),
      },
    });

    await registerAgentsForRevision(v1, db);

    expect(await agentRow("aif:triager")).toMatchObject({
      runnerId: "claude-default",
      workspaceRef: "trigger",
      versionLabel: "v1.0.0",
    });

    // v2 drops runner + workspace_ref → columns CLEAR; version advances.
    const v2 = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v2.0.0",
      agents: { triager: definitionMd() },
    });

    await registerAgentsForRevision(v2, db);

    expect(await agentRow("aif:triager")).toMatchObject({
      runnerId: null,
      workspaceRef: null,
      versionLabel: "v2.0.0",
    });
  });

  it("preserves runtime state (enabled, quarantine) across re-register", async () => {
    const v1 = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      agents: { triager: definitionMd() },
    });

    await registerAgentsForRevision(v1, db);
    await pool.query(
      `UPDATE "agents" SET "enabled" = false, "quarantined_at" = now(), "quarantine_reason" = 'dirty' WHERE "id" = 'aif:triager'`,
    );

    await registerAgentsForRevision(v1, db);

    const row = await agentRow("aif:triager");

    expect(row?.enabled).toBe(false);
    expect(row?.quarantinedAt).not.toBeNull();
    expect(row?.quarantineReason).toBe("dirty");
  });

  it("reports invalid definitions without writing rows (bad schema + bad recommended cron)", async () => {
    const revisionId = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      agents: {
        ok: definitionMd(),
        broken: "---\nname: X\n---\nbody\n",
        badcron: definitionMd({
          recommendedCron: { expr: "not a cron", timezone: "UTC" },
        }),
      },
    });

    const summary = await registerAgentsForRevision(revisionId, db);

    expect(summary.registered).toEqual(["aif:ok"]);
    expect(summary.invalid.map((i) => i.id).sort()).toEqual([
      "aif:badcron",
      "aif:broken",
    ]);
    expect(await agentRow("aif:broken")).toBeUndefined();
    expect(await agentRow("aif:badcron")).toBeUndefined();
  });

  it("refuses unknown and not-Installed revisions with PRECONDITION", async () => {
    await expect(registerAgentsForRevision(randomUUID(), db)).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    const installing = await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      packageStatus: "Installing",
      agents: { triager: definitionMd() },
    });

    await expect(registerAgentsForRevision(installing, db)).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );
  });

  it("registers nothing for a package without a maister-agents/ dir", async () => {
    const revisionId = await installRevisionFixture({
      flowRefId: "plain",
      versionLabel: "v1.0.0",
      agents: {},
    });

    await rm(
      path.join(
        (
          await pool.query(
            `SELECT "installed_path" FROM "flow_revisions" WHERE "id" = $1`,
            [revisionId],
          )
        ).rows[0].installed_path as string,
        "maister-agents",
      ),
      { recursive: true, force: true },
    );

    const summary = await registerAgentsForRevision(revisionId, db);

    expect(summary.registered).toEqual([]);
    expect(summary.invalid).toEqual([]);
  });
});

describe("resyncAgents", () => {
  it("projects the newest Installed revision per flow_ref and disables vanished agents", async () => {
    const older = new Date(Date.now() - 60_000);

    await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v1.0.0",
      installedAt: older,
      agents: { triager: definitionMd(), dropped: definitionMd() },
    });
    // Newest revision no longer ships `dropped`.
    await installRevisionFixture({
      flowRefId: "aif",
      versionLabel: "v2.0.0",
      agents: { triager: definitionMd() },
    });

    // Seed the stale rows from the older revision first.
    const oldRevId = (
      await pool.query(
        `SELECT "id" FROM "flow_revisions" WHERE "version_label" = 'v1.0.0'`,
      )
    ).rows[0].id as string;

    await registerAgentsForRevision(oldRevId, db);
    expect((await agentRow("aif:dropped"))?.enabled).toBe(true);

    const summary = await resyncAgents(db);

    expect(summary.ok).toBe(true);
    expect(summary.missing).toEqual(["aif:dropped"]);
    expect((await agentRow("aif:dropped"))?.enabled).toBe(false);
    expect(await agentRow("aif:triager")).toMatchObject({
      versionLabel: "v2.0.0",
      enabled: true,
    });
  });

  it("disables agents whose providing package has no Installed revision left", async () => {
    const revisionId = await installRevisionFixture({
      flowRefId: "gone",
      versionLabel: "v1.0.0",
      agents: { watcher: definitionMd() },
    });

    await registerAgentsForRevision(revisionId, db);
    await pool.query(
      `UPDATE "flow_revisions" SET "package_status" = 'Removed' WHERE "id" = $1`,
      [revisionId],
    );

    const summary = await resyncAgents(db);

    expect(summary.missing).toEqual(["gone:watcher"]);
    expect((await agentRow("gone:watcher"))?.enabled).toBe(false);
  });
});
