import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { NextRequest } from "next/server";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as fullSchema from "@/lib/db/schema";

// FIXME(any): the delegation suites write seed rows through an untyped schema
// view because the typed insert builders reject the loose fixture literals.
// This mirrors test-support/graph-run-seed.ts's single shared cast.
const schema = fullSchema as unknown as Record<string, any>;

export type DelegationSeedCtx = {
  pool: Pool;
  db: NodePgDatabase;
  /** A per-suite tmpdir standing in for the package install root. */
  agentsRoot: string;
  projectId: string;
  executorId: string;
  /** `projects.repo_path` — a real git repo only when `withGitRepo` was set. */
  repoPath: string;
};

const execFileAsync = promisify(execFile);

/**
 * A real git repo with a `main` branch and one commit.
 *
 * Only the FLOW arm needs it: `launchRunStaged` validates both resolved branch
 * refs against the project's actual branch set before any git side-effect, so a
 * flow launch against a bare path is refused long before the run insert. The
 * refusal suites deliberately skip it — they never reach git, and a repo per
 * `beforeEach` is pure cost there.
 */
export async function initGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-repo-"));

  await execFileAsync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "t@t"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "t"]);
  await writeFile(path.join(dir, "README.md"), "seed\n", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);

  return dir;
}

const TABLES_IN_DELETE_ORDER = [
  "execution_commands",
  "domain_events",
  "run_sessions",
  "workspaces",
  "node_attempts",
  "runs",
  "task_relations",
  "tasks",
  "project_tokens",
  "agent_project_links",
  "agents",
  "project_package_attachments",
  "package_installs",
  "flows",
  "flow_revisions",
  "projects",
];

/**
 * Truncate the delegation working set and seed a fresh project + platform
 * runner + the pinned `test-pkg` package chain the agent effective-definition
 * resolver walks. Returns the context every other helper here takes.
 *
 * Extracted rather than copy-pasted into each suite: the agent-compat replay,
 * the refusal table, and the flow-arm behaviour suites all need the identical
 * fixture, and three drifting copies of it is how a "passing" suite stops
 * testing the thing it names.
 */
export async function resetDelegationFixture(args: {
  pool: Pool;
  db: NodePgDatabase;
  agentsRoot: string;
  /** Back `projects.repo_path` with a real git repo (needed to LAUNCH a flow). */
  withGitRepo?: boolean;
}): Promise<DelegationSeedCtx> {
  const { pool, db, agentsRoot } = args;

  for (const table of TABLES_IN_DELETE_ORDER) {
    await pool.query(`DELETE FROM "${table}"`);
  }

  const projectId = randomUUID();
  const executorId = randomUUID();
  const repoPath = args.withGitRepo
    ? await initGitRepo()
    : `/repos/${projectId}`;

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      repoPath,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  const ctx: DelegationSeedCtx = {
    pool,
    db,
    agentsRoot,
    projectId,
    executorId,
    repoPath,
  };

  // The pinned-package chain the agent effective-definition resolver walks.
  await seedFlow(ctx, { flowRefId: "test-pkg", installedPath: agentsRoot });

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/test-pkg', 'test-pkg', 'v1.0.0', 'rev-pkg-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'test-pkg')`,
    [randomUUID(), projectId, packageInstallId],
  );

  return ctx;
}

export type SeedFlowOptions = {
  flowRefId: string;
  installedPath?: string;
  enablementState?: string;
  trustStatus?: "trusted" | "untrusted";
  packageStatus?:
    | "Discovered"
    | "Installing"
    | "Installed"
    | "Failed"
    | "Removed";
  setupStatus?: "not_required" | "pending" | "done" | "failed";
  schemaVersion?: number;
  engineMin?: string | null;
  engineMax?: string | null;
  /** Leave `flows.enabled_revision_id` NULL (the broken-pointer refusal). */
  withoutEnabledRevision?: boolean;
  /** Insert the flow row but NOT its revision row (the dangling-pointer refusal). */
  withoutRevisionRow?: boolean;
  manifest?: Record<string, unknown>;
};

/**
 * A minimal executable graph manifest: one `cli` node that succeeds. Small
 * enough to keep the fixture readable, real enough that `compileManifest` and
 * the graph runner accept it.
 */
export function minimalGraphManifest(
  name = "Delegated",
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name,
    compat: { engine_min: "3.0.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "true" },
        transitions: { success: "done" },
      },
    ],
  };
}

/** Seed a project flow + its pinned revision. Returns both ids. */
export async function seedFlow(
  ctx: DelegationSeedCtx,
  opts: SeedFlowOptions,
): Promise<{ flowId: string; revisionId: string }> {
  const installedPath =
    opts.installedPath ?? path.join(ctx.agentsRoot, opts.flowRefId);
  const revisionId = randomUUID();
  const flowId = randomUUID();
  const manifest = opts.manifest ?? minimalGraphManifest(opts.flowRefId);

  if (!opts.withoutRevisionRow) {
    await ctx.pool.query(
      `INSERT INTO "flow_revisions"
         ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
          "manifest_digest", "manifest", "schema_version", "engine_min", "engine_max",
          "installed_path", "package_status", "setup_status")
       VALUES ($1, $2, $3, 'v1.0.0', $4, 'digest', $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        revisionId,
        opts.flowRefId,
        `github.com/acme/${opts.flowRefId}`,
        `rev-${opts.flowRefId}`,
        JSON.stringify(manifest),
        opts.schemaVersion ?? 1,
        opts.engineMin ?? null,
        opts.engineMax ?? null,
        installedPath,
        opts.packageStatus ?? "Installed",
        opts.setupStatus ?? "done",
      ],
    );
  }

  await ctx.pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, $3, $4, 'v1.0.0', $5, $6::jsonb, $7, $8, $9, $10, 'pinned')`,
    [
      flowId,
      ctx.projectId,
      opts.flowRefId,
      `github.com/acme/${opts.flowRefId}`,
      installedPath,
      JSON.stringify(manifest),
      opts.schemaVersion ?? 1,
      opts.withoutEnabledRevision ? null : revisionId,
      opts.enablementState ?? "Enabled",
      opts.trustStatus ?? "trusted",
    ],
  );

  return { flowId, revisionId };
}

/**
 * Seed an agent definition file + catalog row + project link inside `test-pkg`.
 * Returns the package-qualified id.
 */
export async function seedAgent(
  ctx: DelegationSeedCtx,
  args: {
    id: string;
    enabled?: boolean;
    /**
     * Declared triggers. The launcher refuses a trigger the definition does not
     * declare, so a suite that drives the agent through the as-plan
     * auto-launcher (trigger `domain_event`) must widen this — the default
     * `["manual"]` covers the delegation routes only.
     */
    triggers?: string[];
  },
): Promise<string> {
  const qualifiedId = `test-pkg:${args.id}`;
  const triggers = args.triggers ?? ["manual"];

  await mkdir(path.join(ctx.agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(ctx.agentsRoot, "maister-agents", `${args.id}.md`),
    `---
name: ${args.id}
description: d
workspace: none
mode: session
triggers:
${triggers.map((t) => `  - ${t}`).join("\n")}
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await ctx.pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', $5::jsonb, 'read_only', $3, $4)`,
    [
      qualifiedId,
      args.id,
      path.join(ctx.agentsRoot, "maister-agents", `${args.id}.md`),
      args.enabled ?? true,
      JSON.stringify(triggers),
    ],
  );
  await ctx.pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, ctx.projectId],
  );

  return qualifiedId;
}

/**
 * Seed an agent shipped by a SEPARATE package whose project flow row and
 * package install carry the given trust / attachment state, with the agents-row
 * kill switch left ON. This is the trust contour
 * `resolveEffectiveAgentDefinition` enforces SEPARATELY from that kill switch:
 * a catalog-enabled agent whose PACKAGE is untrusted or unattached must still
 * refuse to launch. Returns the package-qualified id.
 */
export async function seedUntrustedPackageAgent(
  ctx: DelegationSeedCtx,
  args: {
    id: string;
    flowRefId?: string;
    trustStatus?: "trusted" | "untrusted";
    enablementState?: "Enabled" | "Disabled";
  },
): Promise<string> {
  const flowRefId = args.flowRefId ?? "untrusted-pkg";
  const qualifiedId = `${flowRefId}:${args.id}`;
  const installedPath = path.join(ctx.agentsRoot, flowRefId);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", `${args.id}.md`),
    `---
name: ${args.id}
description: d
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await seedFlow(ctx, {
    flowRefId,
    installedPath,
    enablementState: args.enablementState ?? "Enabled",
    trustStatus: args.trustStatus ?? "untrusted",
  });

  // The package-anchored chain. A "Disabled" package means NOT attached —
  // attachment IS the enable in the package model.
  const installId = randomUUID();

  await ctx.pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, $2, $3, 'v1.0.0', $4, '{}'::jsonb, 'digest', $5, 'Installed', $6)`,
    [
      installId,
      `github.com/acme/${flowRefId}`,
      flowRefId,
      `rev-${flowRefId}-pkg`,
      installedPath,
      args.trustStatus ?? "untrusted",
    ],
  );

  if ((args.enablementState ?? "Enabled") !== "Disabled") {
    await ctx.pool.query(
      `INSERT INTO "project_package_attachments"
         ("id", "project_id", "package_install_id", "package_name")
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), ctx.projectId, installId, flowRefId],
    );
  }

  await ctx.pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, $2, 'v1.0.0', 'git', $3, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $4, true)`,
    [
      qualifiedId,
      flowRefId,
      args.id,
      path.join(installedPath, "maister-agents", `${args.id}.md`),
    ],
  );
  await ctx.pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, ctx.projectId],
  );

  return qualifiedId;
}

/** Seed a plain board task (used as the orchestrator's own task). */
export async function seedTask(
  ctx: DelegationSeedCtx,
  args: { title?: string; status?: string; flowId?: string | null } = {},
): Promise<{ id: string; number: number }> {
  const id = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await ctx.pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number", "flow_id")
     VALUES ($1, $2, $3, $4, 'coordinate', $5, $5, 1, $6)`,
    [
      id,
      ctx.projectId,
      number,
      args.title ?? "Orchestrator task",
      args.status ?? "InFlight",
      args.flowId ?? null,
    ],
  );

  return { id, number };
}

/** Seed an orchestrator parent run plus its run-bound delegation token. */
export async function seedOrchestratorRun(
  ctx: DelegationSeedCtx,
  args: {
    orchestratorAgentId: string;
    taskId?: string | null;
    rootRunId?: string | null;
    parentRunId?: string | null;
    status?: string;
    issueToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
  },
): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await ctx.pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
     VALUES ($1, 'agent', $2, $3, $4, $7, 'agent', 'manual', $5, $6)`,
    [
      runId,
      args.orchestratorAgentId,
      ctx.projectId,
      args.taskId ?? null,
      args.parentRunId ?? null,
      args.rootRunId ?? null,
      args.status ?? "Running",
    ],
  );

  await ctx.pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_snapshot", "runner_id")
     VALUES ($1, $2, 'default', '{"capabilityAgent":"claude"}'::jsonb, $3)`,
    [randomUUID(), runId, ctx.executorId],
  );

  const { secret } = await args.issueToken({
    projectId: ctx.projectId,
    runId,
    db: ctx.db,
  });

  return { runId, secret };
}

/** Seed a live delegated child run under `parentRunId` (fan-out fixtures). */
export async function seedChildRun(
  ctx: DelegationSeedCtx,
  args: {
    parentRunId: string;
    rootRunId?: string | null;
    runKind?: "flow" | "agent";
    status?: string;
    agentId?: string | null;
    flowId?: string | null;
    taskId?: string | null;
  },
): Promise<string> {
  const runId = randomUUID();

  await ctx.pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "flow_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "launch_mode")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'v1', 'rev', $8, $9, 'manual')`,
    [
      runId,
      args.runKind ?? "agent",
      args.agentId ?? null,
      args.flowId ?? null,
      ctx.projectId,
      args.taskId ?? null,
      args.status ?? "Running",
      args.parentRunId,
      args.rootRunId ?? args.parentRunId,
    ],
  );

  return runId;
}

export function delegateRequest(
  secret: string | null,
  body: unknown,
): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

export function planRequest(secret: string | null, body: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/runs/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

export async function countRows(
  ctx: DelegationSeedCtx,
  table: "runs" | "tasks" | "task_relations",
): Promise<number> {
  const r = await ctx.pool.query(`SELECT count(*)::int AS n FROM "${table}"`);

  return r.rows[0].n;
}
