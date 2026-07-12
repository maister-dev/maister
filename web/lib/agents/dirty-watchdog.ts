import "server-only";

import { stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";
import { atomicWriteText } from "@/lib/atomic";
import {
  AGENT_MATERIALIZATION_ROOT_RELATIVE,
  PACKAGE_SKILLS_MANIFEST_RELATIVE,
  agentMaterializationPathsForRun,
  listAgentMaterializationRunIds,
  materializeWithAgentLease,
  normalizeAgentMaterializationPath,
  releaseAgentMaterialization,
} from "@/lib/agents/materialization-manifest";
import {
  agentL2SettingsMarker,
  reclaimCapabilitySettings,
  readSettingsOwner,
  SETTINGS_BACKUP_RELATIVE,
  SETTINGS_MARKER_RELATIVE,
  SETTINGS_OPERATION_RELATIVE,
  SETTINGS_RELATIVE,
} from "@/lib/capabilities/settings-ownership";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { recordTaskActivity } from "@/lib/social/activity";
import { addTaskComment } from "@/lib/social/comments";
import { statusPorcelain } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, projects } = schemaModule as unknown as Record<string, any>;

type Db = any;

const log = pino({
  name: "agent-dirty-watchdog",
  level: process.env.LOG_LEVEL ?? "info",
});

const MARKER_RELATIVE = SETTINGS_MARKER_RELATIVE;
const AGENT_MATERIALIZATION_MUTEX_FILES = [
  "mutex.sqlite",
  "mutex.sqlite-journal",
  "mutex.sqlite-shm",
  "mutex.sqlite-wal",
] as const;
const AGENT_MATERIALIZATION_INDEX_RELATIVE =
  `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/index.json`;

// ADR-090 L2 (materialize-only, ADR-041 boundary unchanged): instructed
// deny rules for write-class tools. Best-effort instruction for well-behaved
// agents; L1 (readOnlySession) and L3 (this watchdog) are the real layers.
// The maister MCP facade is allow-listed: its tools (triage/comments/
// relations — the agent's sanctioned write channel) must never reach a
// permission round-trip, which L1 would fail-closed deny on a headless
// session.
const READ_ONLY_SETTINGS = `${JSON.stringify(
  {
    permissions: {
      allow: ["mcp__maister"],
      deny: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"],
    },
  },
  null,
  2,
)}\n`;

export function agentMaterializationManifest(cwd: string): string[] {
  return [
    path.join(cwd, SETTINGS_RELATIVE),
    path.join(cwd, MARKER_RELATIVE),
    path.join(cwd, SETTINGS_BACKUP_RELATIVE),
    path.join(cwd, SETTINGS_OPERATION_RELATIVE),
    path.join(cwd, PACKAGE_SKILLS_MANIFEST_RELATIVE),
  ];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

// Writes the L2 deny-rule settings into the session cwd. Refuses to clobber
// a user-owned settings file (exists without our marker) — L2 is skipped
// with a WARN and L1/L3 carry the contract alone.
export async function materializeAgentReadOnlySettings(
  cwd: string,
  adapterId: string,
  runId: string,
): Promise<{ materialized: boolean }> {
  const materializer = getAdapterSupportById(adapterId)?.readOnlyMaterializer;

  if (materializer !== "claude-settings") {
    log.debug(
      { adapterId, runId, cwd, materializer: materializer ?? "none" },
      "L2 descriptor selects no read-only materializer",
    );

    return { materialized: false };
  }

  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  const markerPath = path.join(cwd, MARKER_RELATIVE);
  const leased = await materializeWithAgentLease({
    cwd,
    runId,
    materialize: async (ownedPaths, recordIntent, ownedByRunPaths) => {
      const ownsReadOnlySettings =
        ownedByRunPaths.has(SETTINGS_RELATIVE) &&
        ownedByRunPaths.has(MARKER_RELATIVE);
      const foreignSettingsLeasePaths = [
        SETTINGS_RELATIVE,
        SETTINGS_MARKER_RELATIVE,
        SETTINGS_BACKUP_RELATIVE,
        SETTINGS_OPERATION_RELATIVE,
      ].filter(
        (relativePath) =>
          ownedPaths.has(relativePath) && !ownedByRunPaths.has(relativePath),
      );
      const settingsExists = await fileExists(settingsPath);
      const owner = await readSettingsOwner(cwd);

      if (owner === null && foreignSettingsLeasePaths.length > 0) {
        throw new MaisterError(
          "CONFIG",
          `settings.local.json foreign materialization lease lacks an ownership marker: ${foreignSettingsLeasePaths.join(", ")}`,
        );
      }

      if (
        owner !== null &&
        (owner.kind !== "agent-l2" || owner.runId !== runId)
      ) {
        if (ownsReadOnlySettings) {
          throw new MaisterError(
            "CONFIG",
            `agent materialization lease conflicts with ${owner.kind} settings ownership`,
          );
        }
        log.warn(
          { adapterId, runId, cwd, materializer, settingsOwner: owner.kind },
          "L2 skipped because another MAIster writer owns adapter settings",
        );

        return [];
      }

      if (owner?.kind === "agent-l2" && settingsExists) {
        await recordIntent([settingsPath, markerPath]);

        return [settingsPath, markerPath];
      }

      if (settingsExists && owner === null) {
        if (ownsReadOnlySettings) {
          throw new MaisterError(
            "CONFIG",
            `agent materialization lease is inconsistent for ${SETTINGS_RELATIVE}`,
          );
        }
        log.warn(
          { adapterId, runId, cwd, materializer },
          "L2 skipped because a user-owned adapter settings file is present",
        );

        return [];
      }

      await recordIntent([settingsPath, markerPath]);
      if (!settingsExists) {
        await atomicWriteText(settingsPath, READ_ONLY_SETTINGS);
      }
      if (owner === null) {
        await atomicWriteText(markerPath, agentL2SettingsMarker(runId));
      }

      return [settingsPath, markerPath];
    },
  });

  const leasedPaths = new Set(
    leased.map((leasedPath) => path.resolve(leasedPath)),
  );
  const materialized = [settingsPath, markerPath].every((requiredPath) =>
    leasedPaths.has(path.resolve(requiredPath)),
  );

  if (materialized) {
    log.info(
      { adapterId, runId, cwd, materializer },
      "L2 read-only settings materialized",
    );
  }

  return { materialized };
}

// Removes exactly MAIster-owned materialization. Capability settings are
// reclaimed only when this run's manifest tracks their dedicated operation
// artifacts; adapter-home-only paths never imply settings ownership.
export async function restoreAgentMaterialization(
  cwd: string,
  runId: string,
): Promise<void> {
  const trackedPaths = await agentMaterializationPathsForRun(cwd, runId);
  const tracksCapabilitySettings = [
    SETTINGS_BACKUP_RELATIVE,
    SETTINGS_OPERATION_RELATIVE,
  ].some((relativePath) => trackedPaths.includes(relativePath));
  const preservesCapabilitySettings = tracksCapabilitySettings;

  if (preservesCapabilitySettings) {
    const settings = await reclaimCapabilitySettings({ cwd, runId });

    if (settings.status === "failed") {
      throw new MaisterError(
        "CONFIG",
        `capability settings cleanup failed for ${runId}: ${settings.error}`,
      );
    }
    if (settings.status === "foreign") {
      throw new MaisterError(
        "CONFLICT",
        `capability settings cleanup is waiting for ${settings.owner.kind === "unknown" ? "an unknown MAIster writer" : `${settings.owner.kind} run ${settings.owner.runId}`}`,
      );
    }
  }

  await releaseAgentMaterialization(cwd, runId, {
    preservePaths: preservesCapabilitySettings ? [SETTINGS_RELATIVE] : [],
  });
  log.info({ cwd, runId }, "agent materialization restored");
}

function isSafeMaterializationRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId) && !runId.includes("..");
}

function materializationMetadataPaths(runIds: readonly string[]): string[] {
  return [
    AGENT_MATERIALIZATION_INDEX_RELATIVE,
    ...AGENT_MATERIALIZATION_MUTEX_FILES.map(
      (fileName) => `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${fileName}`,
    ),
    ...runIds.flatMap((runId) =>
      isSafeMaterializationRunId(runId)
        ? [`${AGENT_MATERIALIZATION_ROOT_RELATIVE}/runs/${runId}.json`]
        : [],
    ),
  ];
}

function normalizeMetadataPath(value: string): string | null {
  if (
    value === AGENT_MATERIALIZATION_INDEX_RELATIVE ||
    AGENT_MATERIALIZATION_MUTEX_FILES.some(
      (fileName) =>
        value === `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${fileName}`,
    )
  ) {
    return value;
  }

  const runRecordPrefix = `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/runs/`;

  if (!value.startsWith(runRecordPrefix) || !value.endsWith(".json")) {
    return null;
  }

  const runId = value.slice(runRecordPrefix.length, -".json".length);

  return isSafeMaterializationRunId(runId) ? value : null;
}

function normalizeOwnedMaterializationPath(value: string): string | null {
  try {
    return normalizeAgentMaterializationPath(value);
  } catch {
    return normalizeMetadataPath(value);
  }
}

// Drops porcelain lines only for explicitly owned artifacts. The watchdog must
// not suppress a user-owned settings file or arbitrary data placed under the
// materialization directory by a misbehaving repo_read agent.
export function filterManifestPorcelain(
  porcelain: string,
  ownedRelativePaths: readonly string[] = [],
): string {
  const ownedPaths = ownedRelativePaths.flatMap((relativePath) => {
    const normalized = normalizeOwnedMaterializationPath(relativePath);

    return normalized ? [normalized] : [];
  });

  return porcelain
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== "" &&
        !porcelainLineOnlyReferencesOwnedPaths(line, ownedPaths),
    )
    .join("\n");
}

function unquotePorcelainPath(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function porcelainLinePaths(line: string): string[] {
  const pathPart = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameIndex = pathPart.lastIndexOf(" -> ");

  if (renameIndex < 0) return [unquotePorcelainPath(pathPart)];

  return [
    unquotePorcelainPath(pathPart.slice(0, renameIndex)),
    unquotePorcelainPath(pathPart.slice(renameIndex + 4)),
  ];
}

function pathMatchesOwnedPath(changedPath: string, ownedPath: string): boolean {
  return (
    changedPath === ownedPath || changedPath.startsWith(`${ownedPath}/`)
  );
}

// A rename touches both names. It is ignorable only when every name is
// explicitly owned; otherwise an agent could move a user file into an owned
// directory and make the resulting deletion invisible to L3.
function porcelainLineOnlyReferencesOwnedPaths(
  line: string,
  ownedPaths: readonly string[],
): boolean {
  const changedPaths = porcelainLinePaths(line);

  return (
    changedPaths.length > 0 &&
    changedPaths.every((changedPath) =>
      ownedPaths.some((ownedPath) =>
        pathMatchesOwnedPath(changedPath, ownedPath),
      ),
    )
  );
}

export type DirtyWatchdogVerdict =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly porcelain: string }
  | { readonly kind: "indeterminate"; readonly error: string };

// ADR-090 L3: verify the no-write invariant for a repo_read run against the
// parent checkout. The launch-time clean-baseline precondition makes any
// remaining dirt attributable.
export async function checkRepoReadDirt(
  repoPath: string,
  runId: string,
): Promise<DirtyWatchdogVerdict> {
  let ownedMaterializationPaths: string[];

  try {
    const recordedRunIds = await listAgentMaterializationRunIds(repoPath);
    const materializationRunIds = [
      ...new Set([...recordedRunIds, runId]),
    ];
    const pathsByRun = await Promise.all(
      materializationRunIds.map((materializationRunId) =>
        agentMaterializationPathsForRun(repoPath, materializationRunId),
      ),
    );
    ownedMaterializationPaths = [
      ...pathsByRun.flat(),
      ...materializationMetadataPaths(materializationRunIds),
    ];
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    log.error(
      { repoPath, runId, error },
      "[FIX:repo-read-watchdog-indeterminate] materialization ownership could not be read",
    );

    return { kind: "indeterminate", error };
  }

  const porcelain = await statusPorcelain({ worktreePath: repoPath });
  const meaningful = filterManifestPorcelain(
    porcelain,
    ownedMaterializationPaths,
  );

  if (meaningful === "") return { kind: "clean" };

  return { kind: "dirty", porcelain: meaningful };
}

// The quarantine transaction (ADR-090): agent flag + reason, plus — when the
// run is task-bound — a system comment and the agent_quarantined activity
// entry, all in the CALLER's transaction (the terminal choke point).
export async function quarantineAgentInTx(args: {
  tx: Db;
  agentId: string;
  runId: string;
  projectId: string;
  taskId: string | null;
  reason: string;
}): Promise<void> {
  await args.tx
    .update(agents)
    .set({
      quarantinedAt: new Date(),
      quarantineReason: args.reason.slice(0, 1024),
      updatedAt: new Date(),
    })
    .where(eq(agents.id, args.agentId));

  if (args.taskId) {
    await addTaskComment(
      {
        taskId: args.taskId,
        body: `Agent \`${args.agentId}\` was quarantined after run ${args.runId}: the workspace contract was violated (${args.reason}). Launches are refused until an admin un-quarantines it.`,
        actor: { type: "system", id: null },
      },
      args.tx,
    );
    await recordTaskActivity(args.tx, {
      taskId: args.taskId,
      projectId: args.projectId,
      actor: { type: "system", id: null },
      eventKind: "agent_quarantined",
      payload: {
        agentId: args.agentId,
        runId: args.runId,
        reason: args.reason,
      },
    });
  }

  log.warn(
    { agentId: args.agentId, runId: args.runId, reason: args.reason },
    "agent quarantined by the dirty-watchdog",
  );
}

// Convenience read used by the terminal choke point.
export async function loadAgentWorkspaceContext(
  db: Db,
  agentId: string,
  projectId: string,
): Promise<{ workspace: string; repoPath: string; slug: string } | null> {
  const agentRows = await db
    .select({ workspace: agents.workspace })
    .from(agents)
    .where(eq(agents.id, agentId));
  const projectRows = await db
    .select({ repoPath: projects.repoPath, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!agentRows[0] || !projectRows[0]) return null;

  return {
    workspace: agentRows[0].workspace as string,
    repoPath: projectRows[0].repoPath as string,
    slug: projectRows[0].slug as string,
  };
}
