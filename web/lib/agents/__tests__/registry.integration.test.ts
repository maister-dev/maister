// ADR-106 re-key: the agents catalog is a projection of INSTALLED PACKAGES —
// `maister-agents/<stem>.md` files at the package ROOT register under
// package-qualified ids `<packageName>:<stem>`. These tests drive
// registerPackageAgents/resyncAgents against real installed-dir fixtures +
// package_installs rows on a real Postgres, and assert the migration 0068
// FK fan-out (the destructive re-key wipe is safe for run history).
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

import { registerPackageAgents, resyncAgents } from "@/lib/agents/registry";
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
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_schedules"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "projects"`);
});

function definitionMd(opts?: {
  runner?: string | null;
  workspaceRef?: string;
  recommendedCron?: { expr: string; timezone: string };
  flow?: string;
  config?: boolean;
}): string {
  const runnerLine = opts?.runner ? `runner: ${opts.runner}\n` : "";
  const refLine = opts?.workspaceRef
    ? `workspace_ref: ${opts.workspaceRef}\n`
    : "";
  const flowLine = opts?.flow ? `flow: ${opts.flow}\n` : "";
  const recommended = opts?.recommendedCron
    ? `recommended:\n  cron:\n    expr: "${opts.recommendedCron.expr}"\n    timezone: ${opts.recommendedCron.timezone}\n`
    : "";
  // ADR-110: a declared config block, gated so the CLEAR half can drop it.
  const config = opts?.config
    ? [
        "config:",
        "  - key: detect_duplicates",
        "    type: boolean",
        "    default: true",
        "  - key: intake_mode",
        "    type: enum",
        "    values:",
        "      - triage_only",
        "      - clarify",
        "    default: clarify",
        "",
      ].join("\n")
    : "";

  return `---
name: Triager
description: Classifies tasks
${runnerLine}workspace: ${opts?.workspaceRef ? "repo_read" : "none"}
${refLine}mode: session
triggers:
  - manual
risk_tier: read_only
${flowLine}${recommended}${config}---
Triage the task.
`;
}

const DECLARED_CONFIG = [
  { key: "detect_duplicates", type: "boolean", default: true },
  {
    key: "intake_mode",
    type: "enum",
    values: ["triage_only", "clarify"],
    default: "clarify",
  },
];

// An installed PACKAGE fixture: a real package-root dir with maister-agents/*.md
// + the package_installs row pointing at it (manifest carries the flows[] used
// for the same-package `flow` membership check).
async function installPackageFixture(opts: {
  name: string;
  versionLabel: string;
  agents: Record<string, string>;
  manifestFlows?: string[];
  source?: string;
  packageStatus?: string;
  createdAt?: Date;
}): Promise<string> {
  const installId = randomUUID();
  const installedPath = path.join(
    cacheRoot,
    `${opts.name}@${opts.versionLabel}-${installId.slice(0, 8)}`,
  );

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  for (const [stem, content] of Object.entries(opts.agents)) {
    await writeFile(
      path.join(installedPath, "maister-agents", `${stem}.md`),
      content,
      "utf8",
    );
  }

  const manifest = {
    spec: {
      name: opts.name,
      flows: (opts.manifestFlows ?? []).map((id) => ({ id })),
    },
    inventory: {
      skills: [],
      agents: [],
      platformAgents: Object.keys(opts.agents),
    },
  };

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status",
        "trust_status", "created_at")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'digest', $7, $8, 'trusted', $9)`,
    [
      installId,
      opts.source ?? "github.com/acme/pkg",
      opts.name,
      opts.versionLabel,
      `rev-${opts.versionLabel}`,
      JSON.stringify(manifest),
      installedPath,
      opts.packageStatus ?? "Installed",
      opts.createdAt ?? new Date(),
    ],
  );

  return installId;
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

describe("registerPackageAgents", () => {
  it("registers package agents under qualified ids with provenance", async () => {
    const installId = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: { triager: definitionMd() },
    });

    const summary = await registerPackageAgents(installId, db);

    expect(summary.registered).toEqual(["aif:triager"]);
    expect(summary.invalid).toEqual([]);

    const row = await agentRow("aif:triager");

    expect(row).toMatchObject({
      id: "aif:triager",
      packageName: "aif",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Triager",
      workspace: "none",
      enabled: true,
    });
    expect(String(row?.sourcePath)).toContain("/maister-agents/triager.md");
  });

  it("derives origin=authored for local filesystem sources", async () => {
    const installId = await installPackageFixture({
      name: "studio-pkg",
      versionLabel: "local-abc123",
      source: "/var/folders/authored-bridge-tmp",
      agents: { helper: definitionMd() },
    });

    await registerPackageAgents(installId, db);

    expect((await agentRow("studio-pkg:helper"))?.origin).toBe("authored");
  });

  it("SET/CLEAR-syncs every parsed column on re-register (upgrade path)", async () => {
    await pool.query(
      `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider")
       VALUES ('claude-default', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb)
       ON CONFLICT DO NOTHING`,
    );

    const v1 = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: {
        triager: definitionMd({
          runner: "claude-default",
          workspaceRef: "trigger",
        }),
      },
    });

    await registerPackageAgents(v1, db);

    expect(await agentRow("aif:triager")).toMatchObject({
      runnerId: "claude-default",
      workspaceRef: "trigger",
      versionLabel: "v1.0.0",
    });

    // v2 drops runner + workspace_ref → columns CLEAR; version advances.
    const v2 = await installPackageFixture({
      name: "aif",
      versionLabel: "v2.0.0",
      agents: { triager: definitionMd() },
    });

    await registerPackageAgents(v2, db);

    expect(await agentRow("aif:triager")).toMatchObject({
      runnerId: null,
      workspaceRef: null,
      versionLabel: "v2.0.0",
    });
  });

  it("SET/CLEAR/re-set syncs config_schema from the .md config block (ADR-110)", async () => {
    // SET: the .md declares config → column equals the declared array.
    const withConfig = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: { triager: definitionMd({ config: true }) },
    });

    await registerPackageAgents(withConfig, db);
    expect((await agentRow("aif:triager"))?.configSchema).toEqual(
      DECLARED_CONFIG,
    );

    // CLEAR: a re-sync of a version that drops `config:` resets the column.
    const noConfig = await installPackageFixture({
      name: "aif",
      versionLabel: "v2.0.0",
      agents: { triager: definitionMd() },
    });

    await registerPackageAgents(noConfig, db);
    expect((await agentRow("aif:triager"))?.configSchema).toBeNull();

    // RE-SET: re-adding `config:` makes the column equal again (idempotent).
    const reAdded = await installPackageFixture({
      name: "aif",
      versionLabel: "v3.0.0",
      agents: { triager: definitionMd({ config: true }) },
    });

    await registerPackageAgents(reAdded, db);
    expect((await agentRow("aif:triager"))?.configSchema).toEqual(
      DECLARED_CONFIG,
    );
  });

  it("preserves runtime state (enabled, quarantine) across re-register", async () => {
    const v1 = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: { triager: definitionMd() },
    });

    await registerPackageAgents(v1, db);
    await pool.query(
      `UPDATE "agents" SET "enabled" = false, "quarantined_at" = now(), "quarantine_reason" = 'dirty' WHERE "id" = 'aif:triager'`,
    );

    await registerPackageAgents(v1, db);

    const row = await agentRow("aif:triager");

    expect(row?.enabled).toBe(false);
    expect(row?.quarantinedAt).not.toBeNull();
    expect(row?.quarantineReason).toBe("dirty");
  });

  it("validates the same-package flow: stores a valid flowRef, rejects a non-member", async () => {
    const installId = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      manifestFlows: ["bugfix"],
      agents: {
        driver: definitionMd({ flow: "bugfix" }),
        stray: definitionMd({ flow: "ghost" }),
      },
    });

    const summary = await registerPackageAgents(installId, db);

    expect(summary.registered).toEqual(["aif:driver"]);
    expect(summary.invalid.map((i) => i.id)).toEqual(["aif:stray"]);
    expect((await agentRow("aif:driver"))?.flowRef).toBe("bugfix");
    expect(await agentRow("aif:stray")).toBeUndefined();
  });

  it("reports invalid definitions without writing rows (bad schema + bad recommended cron)", async () => {
    const installId = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: {
        ok: definitionMd(),
        broken: "---\nname: X\n---\nbody\n",
        badcron: definitionMd({
          recommendedCron: { expr: "not a cron", timezone: "UTC" },
        }),
      },
    });

    const summary = await registerPackageAgents(installId, db);

    expect(summary.registered).toEqual(["aif:ok"]);
    expect(summary.invalid.map((i) => i.id).sort()).toEqual([
      "aif:badcron",
      "aif:broken",
    ]);
    expect(await agentRow("aif:broken")).toBeUndefined();
    expect(await agentRow("aif:badcron")).toBeUndefined();
  });

  it("refuses unknown and not-Installed package installs with PRECONDITION", async () => {
    await expect(registerPackageAgents(randomUUID(), db)).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    const installing = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      packageStatus: "Installing",
      agents: { triager: definitionMd() },
    });

    await expect(registerPackageAgents(installing, db)).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );
  });

  it("registers nothing for a package without a maister-agents/ dir", async () => {
    const installId = await installPackageFixture({
      name: "plain",
      versionLabel: "v1.0.0",
      agents: {},
    });

    await rm(
      path.join(
        (
          await pool.query(
            `SELECT "installed_path" FROM "package_installs" WHERE "id" = $1`,
            [installId],
          )
        ).rows[0].installed_path as string,
        "maister-agents",
      ),
      { recursive: true, force: true },
    );

    const summary = await registerPackageAgents(installId, db);

    expect(summary.registered).toEqual([]);
    expect(summary.invalid).toEqual([]);
  });
});

describe("resyncAgents", () => {
  it("projects the newest Installed install per package name and disables vanished agents", async () => {
    const older = new Date(Date.now() - 60_000);

    await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      createdAt: older,
      agents: { triager: definitionMd(), dropped: definitionMd() },
    });
    // Newest install no longer ships `dropped`.
    await installPackageFixture({
      name: "aif",
      versionLabel: "v2.0.0",
      agents: { triager: definitionMd() },
    });

    // Seed the stale rows from the older install first.
    const oldId = (
      await pool.query(
        `SELECT "id" FROM "package_installs" WHERE "version_label" = 'v1.0.0'`,
      )
    ).rows[0].id as string;

    await registerPackageAgents(oldId, db);
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

  it("disables agents whose providing package has no Installed install left", async () => {
    const installId = await installPackageFixture({
      name: "gone",
      versionLabel: "v1.0.0",
      agents: { watcher: definitionMd() },
    });

    await registerPackageAgents(installId, db);
    await pool.query(
      `UPDATE "package_installs" SET "package_status" = 'Removed' WHERE "id" = $1`,
      [installId],
    );

    const summary = await resyncAgents(db);

    expect(summary.missing).toEqual(["gone:watcher"]);
    expect((await agentRow("gone:watcher"))?.enabled).toBe(false);
  });
});

describe("migration 0068 data policy (DELETE FROM agents FK fan-out)", () => {
  it("cascades agent_project_links + agent_schedules and SET-NULLs runs.agent_id", async () => {
    const projectId = randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      slug: "fanout",
      name: "Fan-out",
      repoPath: "/tmp/fanout",
      maisterYamlPath: "/tmp/fanout/maister.yaml",
      taskKey: "FAN",
    });

    const installId = await installPackageFixture({
      name: "aif",
      versionLabel: "v1.0.0",
      agents: { helper: definitionMd() },
    });

    await registerPackageAgents(installId, db);

    const linkId = randomUUID();

    await pool.query(
      `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "enabled")
       VALUES ($1, 'aif:helper', $2, true)`,
      [linkId, projectId],
    );
    await pool.query(
      `INSERT INTO "agent_schedules"
         ("id", "agent_id", "project_id", "trigger_type", "event_match", "enabled")
       VALUES ($1, 'aif:helper', $2, 'event', '{"kinds":["run.failed"]}'::jsonb, true)`,
      [randomUUID(), projectId],
    );

    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "flow_version", "status")
       VALUES ($1, 'agent', 'aif:helper', $2, 'v1', 'Done')`,
      [runId, projectId],
    );

    // The destructive re-key wipe.
    await pool.query(`DELETE FROM "agents"`);

    const links = await pool.query(
      `SELECT "id" FROM "agent_project_links" WHERE "id" = $1`,
      [linkId],
    );
    const schedules = await pool.query(
      `SELECT "id" FROM "agent_schedules" WHERE "agent_id" = 'aif:helper'`,
    );
    const run = await pool.query(
      `SELECT "id", "agent_id" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(links.rowCount).toBe(0); // CASCADE
    expect(schedules.rowCount).toBe(0); // CASCADE
    expect(run.rowCount).toBe(1); // run history survives
    expect(run.rows[0].agent_id).toBeNull(); // SET NULL
  });
});
