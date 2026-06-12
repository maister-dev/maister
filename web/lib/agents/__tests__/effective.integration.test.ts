// RD4 (ADR-089 rework): the effective-definition resolver — per-project
// pinned-version resolution behind the flow-launch enablement/trust gates.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { isMaisterError } from "@/lib/errors";
import { upgradePreview } from "@/lib/flows/lifecycle";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-effective-"));

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
  await pool.query(`DELETE FROM "projects"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "agents"`);
});

async function seedProject(slug: string): Promise<string> {
  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4)`,
    [
      projectId,
      slug,
      `/repos/${slug}-${projectId.slice(0, 8)}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  return projectId;
}

function md(marker: string, triggers: string[] = ["manual"]): string {
  return `---
name: Triager
description: d
workspace: none
mode: session
triggers:
${triggers.map((t) => `  - ${t}`).join("\n")}
risk_tier: read_only
---
${marker}
`;
}

async function installRevision(opts: {
  flowRefId: string;
  versionLabel: string;
  agents: Record<string, string>;
}): Promise<string> {
  const revisionId = randomUUID();
  const installedPath = path.join(
    cacheRoot,
    `${opts.flowRefId}@${opts.versionLabel}-${revisionId.slice(0, 8)}`,
  );

  await mkdir(path.join(installedPath, "agents"), { recursive: true });
  for (const [stem, content] of Object.entries(opts.agents)) {
    await writeFile(
      path.join(installedPath, "agents", `${stem}.md`),
      content,
      "utf8",
    );
  }

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, $2, 'github.com/acme/pkg', $3, $4, 'digest', '{}'::jsonb, 1, $5, 'Installed')`,
    [
      revisionId,
      opts.flowRefId,
      opts.versionLabel,
      `rev-${opts.versionLabel}-${revisionId.slice(0, 6)}`,
      installedPath,
    ],
  );

  return revisionId;
}

async function pinFlow(opts: {
  projectId: string;
  flowRefId: string;
  revisionId: string;
  enablementState?: string;
  trustStatus?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, $3, 'github.com/acme/pkg', 'v', '/x', '{}'::jsonb, 1, $4, $5, $6, 'pinned')`,
    [
      randomUUID(),
      opts.projectId,
      opts.flowRefId,
      opts.revisionId,
      opts.enablementState ?? "Enabled",
      opts.trustStatus ?? "trusted",
    ],
  );
}

function expectPrecondition(promise: Promise<unknown>, match: RegExp) {
  return promise.then(
    () => expect.unreachable("expected PRECONDITION"),
    (err: unknown) => {
      expect(isMaisterError(err)).toBe(true);
      if (isMaisterError(err)) {
        expect(err.code).toBe("PRECONDITION");
        expect(err.message).toMatch(match);
      }
    },
  );
}

describe("resolveEffectiveAgentDefinition (RD4)", () => {
  it("two projects pinned to different versions resolve different definitions", async () => {
    const p1 = await seedProject("eff-p1");
    const p2 = await seedProject("eff-p2");
    const v1 = await installRevision({
      flowRefId: "pkg",
      versionLabel: "v1.0.0",
      agents: { triager: md("V1-BODY") },
    });
    const v2 = await installRevision({
      flowRefId: "pkg",
      versionLabel: "v2.0.0",
      agents: { triager: md("V2-BODY", ["manual", "cron"]) },
    });

    await pinFlow({ projectId: p1, flowRefId: "pkg", revisionId: v1 });
    await pinFlow({ projectId: p2, flowRefId: "pkg", revisionId: v2 });

    const e1 = await resolveEffectiveAgentDefinition(
      { agentId: "pkg:triager", projectId: p1 },
      db,
    );
    const e2 = await resolveEffectiveAgentDefinition(
      { agentId: "pkg:triager", projectId: p2 },
      db,
    );

    expect(e1.parsed.prompt).toContain("V1-BODY");
    expect(e1.versionLabel).toBe("v1.0.0");
    expect(e1.parsed.triggers).toEqual(["manual"]);
    expect(e2.parsed.prompt).toContain("V2-BODY");
    expect(e2.versionLabel).toBe("v2.0.0");
    expect(e2.parsed.triggers).toEqual(["manual", "cron"]);
  });

  it("refuses: package not configured / untrusted / not enabled / missing agent file", async () => {
    const p = await seedProject("eff-gates");
    const rev = await installRevision({
      flowRefId: "gated",
      versionLabel: "v1.0.0",
      agents: { present: md("BODY") },
    });

    // Not configured at all.
    await expectPrecondition(
      resolveEffectiveAgentDefinition(
        { agentId: "gated:present", projectId: p },
        db,
      ),
      /not configured in this project/,
    );

    // Untrusted pin.
    await pinFlow({
      projectId: p,
      flowRefId: "gated",
      revisionId: rev,
      trustStatus: "untrusted",
    });
    await expectPrecondition(
      resolveEffectiveAgentDefinition(
        { agentId: "gated:present", projectId: p },
        db,
      ),
      /not trusted/,
    );

    await pool.query(
      `UPDATE "flows" SET "trust_status" = 'trusted', "enablement_state" = 'Installed' WHERE "flow_ref_id" = 'gated'`,
    );
    await expectPrecondition(
      resolveEffectiveAgentDefinition(
        { agentId: "gated:present", projectId: p },
        db,
      ),
      /not launchable/,
    );

    // Enabled, but the pinned version does not ship the stem.
    await pool.query(
      `UPDATE "flows" SET "enablement_state" = 'Enabled' WHERE "flow_ref_id" = 'gated'`,
    );
    await expectPrecondition(
      resolveEffectiveAgentDefinition(
        { agentId: "gated:absent", projectId: p },
        db,
      ),
      /does not ship agents\/absent\.md/,
    );

    // The happy path still resolves after the gates clear.
    const ok = await resolveEffectiveAgentDefinition(
      { agentId: "gated:present", projectId: p },
      db,
    );

    expect(ok.parsed.prompt).toContain("BODY");
  });
});

describe("resolveAgentProfileMcpServers (RD7)", () => {
  it("resolves declared catalog MCPs and exec-trust-gates stdio servers", async () => {
    const p = await seedProject("eff-mcps");

    await pool.query(
      `INSERT INTO "capability_records"
         ("id", "project_id", "capability_ref_id", "kind", "label", "source",
          "agents", "enforceability", "selected_by_default", "selectable", "material")
       VALUES ($1, $2, 'github', 'mcp', 'GitHub', 'platform',
               '["claude","codex"]'::jsonb, 'enforced', true, true,
               '{"command":"github-mcp","args":[],"envKeys":["GITHUB_TOKEN"],"config":{}}'::jsonb)`,
      [randomUUID(), p],
    );

    const { resolveAgentProfileMcpServers } = await import(
      "@/lib/agents/launch"
    );

    // Trusted package revision → the stdio server reaches the session.
    const trusted = await resolveAgentProfileMcpServers({
      db,
      projectId: p,
      capabilityProfile: { mcps: ["github"] },
      capabilityAgent: "claude",
      execTrust: "trusted",
      runId: "run-x",
    });

    expect(trusted).toHaveLength(1);
    expect(trusted[0]).toMatchObject({
      transport: "stdio",
      command: "github-mcp",
    });

    // Untrusted exec → stdio withheld ("trust → execute, never
    // execute-then-trust").
    const untrusted = await resolveAgentProfileMcpServers({
      db,
      projectId: p,
      capabilityProfile: { mcps: ["github"] },
      capabilityAgent: "claude",
      execTrust: "untrusted",
      runId: "run-x",
    });

    expect(untrusted).toHaveLength(0);

    // No declaration → no catalog MCPs (never the project default set).
    const none = await resolveAgentProfileMcpServers({
      db,
      projectId: p,
      capabilityProfile: null,
      capabilityAgent: "claude",
      execTrust: "trusted",
      runId: "run-x",
    });

    expect(none).toEqual([]);
  });
});

describe("upgradePreview agents break-impact (RD4, owner decision 7)", () => {
  it("joins removed/changed agents against this project's live links and bindings", async () => {
    const p = await seedProject("eff-preview");
    const v1 = await installRevision({
      flowRefId: "pkg2",
      versionLabel: "v1.0.0",
      agents: {
        triager: md("V1", ["manual", "domain_event"]),
        dropped: md("V1"),
      },
    });
    const v2 = await installRevision({
      flowRefId: "pkg2",
      versionLabel: "v2.0.0",
      agents: {
        triager: md("V2", ["manual"]).replace(
          "workspace: none",
          "workspace: repo_read",
        ),
        fresh: md("V2"),
      },
    });

    await pinFlow({ projectId: p, flowRefId: "pkg2", revisionId: v1 });

    // Live usage in THIS project: both agents attached, the triager bound.
    for (const stem of ["triager", "dropped"]) {
      await pool.query(
        `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
         VALUES ($1, 'pkg2', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', '/x')`,
        [`pkg2:${stem}`, stem],
      );
      await pool.query(
        `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
        [randomUUID(), `pkg2:${stem}`, p],
      );
    }
    await pool.query(
      `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match")
       VALUES ($1, 'pkg2:triager', $2, 'event', '{"kinds":["task.created"]}'::jsonb)`,
      [randomUUID(), p],
    );

    const preview = await upgradePreview({
      flowRefId: "pkg2",
      enabledRevisionId: v1,
      candidateRevisionId: v2,
      expectedSource: "github.com/acme/pkg",
      projectId: p,
      db,
    });

    expect(preview.agents.added).toEqual(["pkg2:fresh"]);
    expect(preview.agents.removed).toEqual([
      { id: "pkg2:dropped", attachedHere: true, scheduleCount: 0 },
    ]);

    const changed = preview.agents.changed.find((a) => a.id === "pkg2:triager");

    expect(changed).toMatchObject({
      attachedHere: true,
      scheduleCount: 1,
      droppedTriggers: ["domain_event"],
    });
    expect(changed?.changes).toContain("workspace: none → repo_read");
  });
});
