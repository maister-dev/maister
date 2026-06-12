import "server-only";

import { readdir } from "node:fs/promises";
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
const { agents, flowRevisions } = schemaModule as unknown as Record<
  string,
  any
>;

type Db = any;

const log = pino({
  name: "agents-registry",
  level: process.env.LOG_LEVEL ?? "info",
});

type RevisionRow = {
  id: string;
  flowRefId: string;
  source: string;
  versionLabel: string;
  installedPath: string;
  packageStatus: string;
};

export type AgentRegistrationSummary = {
  flowRefId: string;
  versionLabel: string;
  registered: string[];
  invalid: { id: string; error: string }[];
};

async function listAgentFileStems(installedPath: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(join(installedPath, "agents"), {
      withFileTypes: true,
    });
  } catch {
    return []; // no agents/ dir — a perfectly normal package
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
// written on every sync, so a field removed from the .md resets its column.
// `enabled` and the quarantine pair are runtime state and are NOT touched.
async function upsertAgentRow(
  _db: Db,
  parsed: ParsedAgentDefinition,
  revision: RevisionRow,
  sourcePath: string,
): Promise<void> {
  const syncedColumns = {
    flowRefId: revision.flowRefId,
    versionLabel: revision.versionLabel,
    // Authored installs bridge through a local filesystem source; git
    // installs use a remote ref (flowOrigin precedent, lib/services/runs.ts).
    origin: revision.source.startsWith("/") ? "authored" : "git",
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
    sourcePath,
    updatedAt: new Date(),
  };

  await _db
    .insert(agents)
    .values({ id: parsed.id, ...syncedColumns })
    .onConflictDoUpdate({ target: agents.id, set: syncedColumns });
}

// Register every `agents/<stem>.md` shipped by an installed flow revision
// under the package-qualified id `<flowRefId>:<stem>`. Invalid definitions
// are reported, never written — and never fail the surrounding install.
export async function registerAgentsForRevision(
  revisionId: string,
  db?: Db,
): Promise<AgentRegistrationSummary> {
  const _db = db ?? getDb();

  const rows = (await _db
    .select({
      id: flowRevisions.id,
      flowRefId: flowRevisions.flowRefId,
      source: flowRevisions.source,
      versionLabel: flowRevisions.versionLabel,
      installedPath: flowRevisions.installedPath,
      packageStatus: flowRevisions.packageStatus,
    })
    .from(flowRevisions)
    .where(eq(flowRevisions.id, revisionId))) as RevisionRow[];
  const revision = rows[0];

  if (!revision) {
    throw new MaisterError(
      "PRECONDITION",
      `flow revision ${revisionId} not found`,
    );
  }

  if (revision.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `flow revision ${revisionId} is ${revision.packageStatus}, not Installed`,
    );
  }

  const stems = await listAgentFileStems(revision.installedPath);
  const registered: string[] = [];
  const invalid: { id: string; error: string }[] = [];

  for (const stem of stems) {
    const sourcePath = join(revision.installedPath, "agents", `${stem}.md`);
    const id = `${revision.flowRefId}:${stem}`;

    try {
      const qualifiedId = qualifyAgentId(revision.flowRefId, stem);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(sourcePath, "utf8");
      const parsed = parseAgentDefinition(qualifiedId, content);

      assertRecommendedCron(parsed);
      await upsertAgentRow(_db, parsed, revision, sourcePath);
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
        flowRefId: revision.flowRefId,
        versionLabel: revision.versionLabel,
        registered: registered.length,
        invalid: invalid.length,
      },
      "agents registered from flow revision",
    );
  }

  return {
    flowRefId: revision.flowRefId,
    versionLabel: revision.versionLabel,
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

// Re-project the catalog from installed packages: for every flow_ref the
// NEWEST Installed revision wins the index rows; rows whose providing
// package (or file within it) vanished are disabled — never silently
// deleted (attachments and run history keep their FK anchor).
export async function resyncAgents(db?: Db): Promise<AgentResyncSummary> {
  const _db = db ?? getDb();

  const revisionRows = (await _db
    .select({
      id: flowRevisions.id,
      flowRefId: flowRevisions.flowRefId,
      installedAt: flowRevisions.installedAt,
    })
    .from(flowRevisions)
    .where(eq(flowRevisions.packageStatus, "Installed"))
    .orderBy(desc(flowRevisions.installedAt))) as Array<{
    id: string;
    flowRefId: string;
    installedAt: Date;
  }>;

  const newestByFlowRef = new Map<string, string>();

  for (const row of revisionRows) {
    if (!newestByFlowRef.has(row.flowRefId)) {
      newestByFlowRef.set(row.flowRefId, row.id);
    }
  }

  const seen = new Set<string>();
  const invalid: { id: string; error: string }[] = [];
  let synced = 0;

  for (const revisionId of newestByFlowRef.values()) {
    const summary = await registerAgentsForRevision(revisionId, _db);

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
    "agent catalog resynced from installed revisions",
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
