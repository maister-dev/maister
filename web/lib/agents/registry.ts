import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";

import { eq, inArray } from "drizzle-orm";
import pino from "pino";

import {
  assertAgentId,
  parseAgentDefinition,
  renderAgentDefinition,
  type AgentDefinitionInput,
  type ParsedAgentDefinition,
} from "@/lib/agents/definition";
import {
  agentDirPath,
  agentFilePath,
  systemAgentsRoot,
} from "@/lib/agents/paths";
import { atomicWriteText } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): drizzle-orm ships duplicate peer-dep variants in pnpm; typed
// table imports clash across copies (repo-wide pattern, see schema tests).
const { agents, agentProjectLinks, projects, runs } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agents-registry",
  level: process.env.LOG_LEVEL ?? "info",
});

// Allow-list of run statuses that hold a usage reference: everything that is
// not terminal. A new status is excluded (treated as live) only after being
// explicitly added here.
const TERMINAL_RUN_STATUSES = ["Done", "Failed", "Abandoned"] as const;

async function resolveProjectIdForSlug(
  _db: Db,
  agentId: string,
  slug: string,
): Promise<string> {
  const rows = await _db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!rows[0]) {
    throw new MaisterError(
      "CONFIG",
      `agent "${agentId}": project slug "${slug}" is not a registered project`,
    );
  }

  return rows[0].id as string;
}

// Upsert the parsed index row with SET/CLEAR symmetry: every parsed column is
// written on every sync, so a field removed from the .md resets its column.
// `enabled` and the quarantine pair are runtime state and are NOT touched.
async function upsertAgentRow(
  _db: Db,
  parsed: ParsedAgentDefinition,
  projectId: string | null,
): Promise<void> {
  const syncedColumns = {
    scope: parsed.scope,
    projectId,
    name: parsed.name,
    description: parsed.description,
    runnerId: parsed.runner,
    workspace: parsed.workspace,
    mode: parsed.mode,
    triggers: parsed.triggers,
    capabilityProfile: parsed.capabilityProfile,
    riskTier: parsed.riskTier,
    sourcePath: agentFilePath(parsed.id),
    updatedAt: new Date(),
  };

  await _db
    .insert(agents)
    .values({ id: parsed.id, ...syncedColumns })
    .onConflictDoUpdate({ target: agents.id, set: syncedColumns });

  if (parsed.scope === "project" && projectId) {
    await _db
      .insert(agentProjectLinks)
      .values({ id: randomUUID(), agentId: parsed.id, projectId })
      .onConflictDoNothing();
  }
}

export async function registerAgentFromFile(
  agentId: string,
  db?: Db,
): Promise<ParsedAgentDefinition> {
  const _db = db ?? getDb();
  const filePath = agentFilePath(agentId);

  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch {
    throw new MaisterError(
      "CONFIG",
      `agent "${agentId}": ${filePath} is missing or unreadable`,
    );
  }

  const parsed = parseAgentDefinition(agentId, content);
  const projectId =
    parsed.scope === "project" && parsed.projectSlug
      ? await resolveProjectIdForSlug(_db, agentId, parsed.projectSlug)
      : null;

  await upsertAgentRow(_db, parsed, projectId);
  log.info({ agentId, scope: parsed.scope }, "agent registered");

  return parsed;
}

export type AgentResyncSummary = {
  ok: true;
  synced: number;
  invalid: { id: string; error: string }[];
  missing: string[];
};

// Re-scan the host catalog: parseable dirs upsert (SET/CLEAR symmetric),
// invalid definitions are reported and left untouched in the DB, rows whose
// directory disappeared are disabled — never silently deleted.
export async function resyncAgents(db?: Db): Promise<AgentResyncSummary> {
  const _db = db ?? getDb();
  const root = systemAgentsRoot();

  await mkdir(root, { recursive: true });

  const entries = await readdir(root, { withFileTypes: true });
  const onDisk = new Set<string>();
  const invalid: { id: string; error: string }[] = [];
  let synced = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const id = entry.name;

    try {
      assertAgentId(id);
      await stat(agentFilePath(id));
    } catch {
      continue;
    }

    onDisk.add(id);

    try {
      await registerAgentFromFile(id, _db);
      synced += 1;
    } catch (err) {
      invalid.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rows = await _db.select({ id: agents.id }).from(agents);
  const missing = rows
    .map((r: { id: string }) => r.id)
    .filter((id: string) => !onDisk.has(id));

  if (missing.length > 0) {
    await _db
      .update(agents)
      .set({ enabled: false, updatedAt: new Date() })
      .where(inArray(agents.id, missing));
    log.warn({ missing }, "agents with missing catalog dirs disabled");
  }

  log.info(
    { synced, invalid: invalid.length, missing: missing.length },
    "agent catalog resynced",
  );

  return { ok: true, synced, invalid, missing };
}

export async function createAgent(
  input: AgentDefinitionInput,
  db?: Db,
): Promise<ParsedAgentDefinition> {
  const _db = db ?? getDb();

  assertAgentId(input.id);

  const existingRow = await _db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.id));
  let dirExists = false;

  try {
    await stat(agentDirPath(input.id));
    dirExists = true;
  } catch {
    dirExists = false;
  }

  if (existingRow[0] || dirExists) {
    throw new MaisterError("CONFLICT", `agent "${input.id}" already exists`);
  }

  const rendered = renderAgentDefinition(input);

  await mkdir(agentDirPath(input.id), { recursive: true });
  await atomicWriteText(agentFilePath(input.id), rendered);

  return registerAgentFromFile(input.id, _db);
}

export async function updateAgentDefinition(
  input: AgentDefinitionInput,
  db?: Db,
): Promise<ParsedAgentDefinition> {
  const _db = db ?? getDb();

  const existing = await _db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.id));

  if (!existing[0]) {
    throw new MaisterError("PRECONDITION", `agent "${input.id}" not found`);
  }

  const rendered = renderAgentDefinition(input);

  await mkdir(agentDirPath(input.id), { recursive: true });
  await atomicWriteText(agentFilePath(input.id), rendered);

  return registerAgentFromFile(input.id, _db);
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

export async function deleteAgent(agentId: string, db?: Db): Promise<void> {
  const _db = db ?? getDb();

  const existing = await _db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, agentId));

  if (!existing[0]) {
    throw new MaisterError("PRECONDITION", `agent "${agentId}" not found`);
  }

  const liveRuns = await _db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.agentId, agentId));
  const live = liveRuns.filter(
    (r: { status: string }) =>
      !TERMINAL_RUN_STATUSES.includes(
        r.status as (typeof TERMINAL_RUN_STATUSES)[number],
      ),
  );

  if (live.length > 0) {
    throw new MaisterError(
      "CONFLICT",
      `agent "${agentId}" has ${live.length} live run(s); stop them before deleting`,
    );
  }

  await _db.delete(agents).where(eq(agents.id, agentId));
  await rm(agentDirPath(agentId), { recursive: true, force: true });
  log.info({ agentId }, "agent deleted");
}

export async function listAgents(db?: Db): Promise<Record<string, unknown>[]> {
  const _db = db ?? getDb();

  return _db.select().from(agents);
}
