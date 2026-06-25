import "server-only";

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { desc, eq, inArray } from "drizzle-orm";
import pino from "pino";

import {
  parseAgentDefinition,
  qualifyAgentId,
  type ParsedAgentDefinition,
} from "@/lib/agents/definition";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  validateCronExpression,
  validateTimezone,
} from "@/lib/run-schedules/cron";

// FIXME(any): drizzle-orm ships duplicate peer-dep variants in pnpm; typed
// table imports clash across copies (repo-wide pattern, see schema tests).
const { agents, packageInstalls } = schemaModule as unknown as Record<
  string,
  any
>;

type Db = any;

const log = pino({
  name: "agents-registry",
  level: process.env.LOG_LEVEL ?? "info",
});

type InstallRow = {
  id: string;
  name: string;
  versionLabel: string;
  installedPath: string;
  packageStatus: string;
  sourceUrl: string;
  // The stored jsonb is the PackageInstallManifest ({ spec, inventory, … }).
  manifest: { spec?: { flows?: Array<{ id: string }> } } | null;
};

export type AgentRegistrationSummary = {
  packageName: string;
  versionLabel: string;
  registered: string[];
  invalid: { id: string; error: string }[];
};

async function listAgentFileStems(installedPath: string): Promise<string[]> {
  let entries;

  try {
    // (ADR-106) Platform-agent definitions live at the PACKAGE ROOT
    // `maister-agents/` — distinct from capability subagents
    // (`capability/<id>/agents/`). Scanned off `package_installs.installed_path`
    // (the package root), never a member flow revision's per-flow cache dir.
    entries = await readdir(join(installedPath, "maister-agents"), {
      withFileTypes: true,
    });
  } catch {
    return []; // no maister-agents/ dir — a perfectly normal package
  }

  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => basename(e.name, ".md"));
}

// `recommended.cron` is shape-validated by the parser (client-safe); the
// expression/timezone semantics need the server-side cron engine, so they
// gate registration here — a package recommending a broken schedule is
// reported invalid instead of poisoning the attach pre-fill.
function assertRecommendedCron(parsed: ParsedAgentDefinition): void {
  const cron = parsed.recommended?.cron;

  if (!cron) return;
  validateTimezone(cron.timezone);
  validateCronExpression(cron.expr, cron.timezone);
}

// Upsert the parsed index row with SET/CLEAR symmetry: every parsed column is
// written on every sync, so a field removed from the .md resets its column
// (flowRef, branchBase, runnerId, workspaceRef, configSchema all CLEAR to null
// when absent). `enabled` and the quarantine pair are runtime state, NOT touched.
async function upsertAgentRow(
  _db: Db,
  parsed: ParsedAgentDefinition,
  install: InstallRow,
  sourcePath: string,
): Promise<void> {
  const syncedColumns = {
    packageName: install.name,
    versionLabel: install.versionLabel,
    // Authored installs bridge through a local filesystem source; git
    // installs use a remote ref (flowOrigin precedent, lib/services/runs.ts).
    origin: install.sourceUrl.startsWith("/") ? "authored" : "git",
    name: parsed.name,
    description: parsed.description,
    runnerId: parsed.runner,
    workspace: parsed.workspace,
    workspaceRef: parsed.workspaceRef,
    mode: parsed.mode,
    triggers: parsed.triggers,
    capabilityProfile: parsed.capabilityProfile,
    riskTier: parsed.riskTier,
    recommended: parsed.recommended,
    // (ADR-111) SET/CLEAR symmetric: written on EVERY sync, so removing the
    // `config:` block from the .md resets the column to null on resync.
    configSchema: parsed.config ?? null,
    // (ADR-106) The same-package flow + the seeded branch base; both CLEAR.
    flowRef: parsed.flow,
    branchBase: parsed.recommended?.branch_base ?? null,
    sourcePath,
    updatedAt: new Date(),
  };

  await _db
    .insert(agents)
    .values({ id: parsed.id, ...syncedColumns })
    .onConflictDoUpdate({ target: agents.id, set: syncedColumns });
}

// Register every `maister-agents/<stem>.md` shipped by an installed PACKAGE
// under the package-qualified id `<packageName>:<stem>` (ADR-106). An agent
// declaring a `flow` not present in the package manifest's `flows[]` is
// reported invalid + never written. Invalid definitions are reported, never
// written — and never fail the surrounding install.
export async function registerPackageAgents(
  packageInstallId: string,
  db?: Db,
): Promise<AgentRegistrationSummary> {
  const _db = db ?? getDb();

  const rows = (await _db
    .select({
      id: packageInstalls.id,
      name: packageInstalls.name,
      versionLabel: packageInstalls.versionLabel,
      installedPath: packageInstalls.installedPath,
      packageStatus: packageInstalls.packageStatus,
      sourceUrl: packageInstalls.sourceUrl,
      manifest: packageInstalls.manifest,
    })
    .from(packageInstalls)
    .where(eq(packageInstalls.id, packageInstallId))) as InstallRow[];
  const install = rows[0];

  if (!install) {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${packageInstallId} not found`,
    );
  }

  if (install.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `package install ${packageInstallId} is ${install.packageStatus}, not Installed`,
    );
  }

  // The membership allow-list for an agent's optional same-package `flow`.
  const manifestFlowIds = new Set<string>(
    (install.manifest?.spec?.flows ?? []).map((f) => f.id),
  );

  const stems = await listAgentFileStems(install.installedPath);
  const registered: string[] = [];
  const invalid: { id: string; error: string }[] = [];

  for (const stem of stems) {
    const sourcePath = join(
      install.installedPath,
      "maister-agents",
      `${stem}.md`,
    );
    const id = `${install.name}:${stem}`;

    try {
      const qualifiedId = qualifyAgentId(install.name, stem);
      const content = await readFile(sourcePath, "utf8");
      const parsed = parseAgentDefinition(qualifiedId, content);

      assertRecommendedCron(parsed);

      if (parsed.flow && !manifestFlowIds.has(parsed.flow)) {
        throw new MaisterError(
          "CONFIG",
          `flow "${parsed.flow}" is not a flow of package "${install.name}"`,
        );
      }

      await upsertAgentRow(_db, parsed, install, sourcePath);
      registered.push(qualifiedId);
    } catch (err) {
      invalid.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (registered.length > 0 || invalid.length > 0) {
    log.info(
      {
        packageName: install.name,
        versionLabel: install.versionLabel,
        registered: registered.length,
        invalid: invalid.length,
      },
      "agents registered from package install",
    );
  }

  return {
    packageName: install.name,
    versionLabel: install.versionLabel,
    registered,
    invalid,
  };
}

export type AgentResyncSummary = {
  ok: true;
  synced: number;
  invalid: { id: string; error: string }[];
  missing: string[];
};

// Re-project the catalog from installed packages: for every package NAME the
// NEWEST Installed `package_installs` row wins the index rows (ADR-106; was
// newest revision per flow_ref); rows whose providing package (or file within
// it) vanished are disabled — never silently deleted (attachments and run
// history keep their FK anchor).
export async function resyncAgents(db?: Db): Promise<AgentResyncSummary> {
  const _db = db ?? getDb();

  const installRows = (await _db
    .select({
      id: packageInstalls.id,
      name: packageInstalls.name,
      createdAt: packageInstalls.createdAt,
    })
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"))
    .orderBy(desc(packageInstalls.createdAt))) as Array<{
    id: string;
    name: string;
    createdAt: Date;
  }>;

  const newestByName = new Map<string, string>();

  for (const row of installRows) {
    if (!newestByName.has(row.name)) {
      newestByName.set(row.name, row.id);
    }
  }

  const seen = new Set<string>();
  const invalid: { id: string; error: string }[] = [];
  let synced = 0;

  for (const installId of newestByName.values()) {
    const summary = await registerPackageAgents(installId, _db);

    summary.registered.forEach((id) => seen.add(id));
    invalid.push(...summary.invalid);
    synced += summary.registered.length;
  }

  const rows = await _db.select({ id: agents.id }).from(agents);
  const missing = rows
    .map((r: { id: string }) => r.id)
    .filter((id: string) => !seen.has(id));

  if (missing.length > 0) {
    await _db
      .update(agents)
      .set({ enabled: false, updatedAt: new Date() })
      .where(inArray(agents.id, missing));
    log.warn(
      { missing },
      "agents without an installed providing package disabled",
    );
  }

  log.info(
    { synced, invalid: invalid.length, missing: missing.length },
    "agent catalog resynced from installed packages",
  );

  return { ok: true, synced, invalid, missing };
}

export async function setAgentEnabled(
  agentId: string,
  enabled: boolean,
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const updated = await _db
    .update(agents)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });

  if (!updated[0]) {
    throw new MaisterError("PRECONDITION", `agent "${agentId}" not found`);
  }

  log.info({ agentId, enabled }, "agent enabled flag updated");
}

export async function unquarantineAgent(
  agentId: string,
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const updated = await _db
    .update(agents)
    .set({ quarantinedAt: null, quarantineReason: null, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });

  if (!updated[0]) {
    throw new MaisterError("PRECONDITION", `agent "${agentId}" not found`);
  }

  log.info({ agentId }, "agent un-quarantined");
}

export async function listAgents(db?: Db): Promise<Record<string, unknown>[]> {
  const _db = db ?? getDb();

  return _db.select().from(agents);
}
