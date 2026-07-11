import "server-only";

import { stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";
import { atomicWriteText } from "@/lib/atomic";
import {
  AGENT_MATERIALIZATION_ROOT_RELATIVE,
  agentMaterializationPathsForRun,
  PACKAGE_SKILLS_MANIFEST_RELATIVE,
  materializeWithAgentLease,
  releaseAgentMaterialization,
} from "@/lib/agents/materialization-manifest";
import * as schemaModule from "@/lib/db/schema";
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

const SETTINGS_RELATIVE = ".claude/settings.local.json";
const MARKER_RELATIVE = ".claude/settings.local.json.maister-owned";
const PACKAGE_MATERIALIZATION_ROOTS = [
  ".claude/skills",
  ".claude/agents",
  ".gemini/skills",
] as const;

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
    materialize: async (ownedPaths) => {
      if (
        ownedPaths.has(SETTINGS_RELATIVE) &&
        ownedPaths.has(MARKER_RELATIVE)
      ) {
        return [settingsPath, markerPath];
      }

      if ((await fileExists(settingsPath)) && !(await fileExists(markerPath))) {
        log.warn(
          { adapterId, runId, cwd, materializer },
          "L2 skipped because a user-owned adapter settings file is present",
        );

        return [];
      }

      await atomicWriteText(settingsPath, READ_ONLY_SETTINGS);
      await atomicWriteText(markerPath, "maister-owned\n");

      return [settingsPath, markerPath];
    },
  });

  const materialized = leased.length === 2;

  if (materialized) {
    log.info(
      { adapterId, runId, cwd, materializer },
      "L2 read-only settings materialized",
    );
  }

  return { materialized };
}

// Removes exactly MAIster-owned materialization. The package-skill manifest is
// session-owned; read-only settings are removed only when our marker is present.
export async function restoreAgentMaterialization(
  cwd: string,
  runId: string,
): Promise<void> {
  await releaseAgentMaterialization(cwd, runId);
  log.info({ cwd, runId }, "L2 materialization restored");
}

// Drops porcelain lines that name manifest-tracked paths — the watchdog
// never attributes our own materialization as agent dirt (belt for the
// restore above).
export function filterManifestPorcelain(
  porcelain: string,
  extraRelativePaths: readonly string[] = [],
): string {
  const ownedRelativePaths = [
    SETTINGS_RELATIVE,
    MARKER_RELATIVE,
    PACKAGE_SKILLS_MANIFEST_RELATIVE,
    AGENT_MATERIALIZATION_ROOT_RELATIVE,
    ...extraRelativePaths.flatMap((relPath) => {
      const normalized = normalizePackageSkillRelativePath(relPath);

      return normalized ? [normalized] : [];
    }),
  ];

  return porcelain
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== "" &&
        !ownedRelativePaths.some((relPath) =>
          porcelainLineReferencesPath(line, relPath),
        ),
    )
    .join("\n");
}

function normalizePackageSkillRelativePath(value: string): string | null {
  if (
    value === "" ||
    value.endsWith("/") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    value !== path.posix.normalize(value)
  ) {
    return null;
  }

  const parts = value.split("/");

  if (parts.includes("..") || parts.includes(".")) return null;

  return PACKAGE_MATERIALIZATION_ROOTS.some(
    (root) => value.startsWith(`${root}/`) && value.length > root.length + 1,
  )
    ? value
    : null;
}

function unquotePorcelainPath(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function porcelainLinePath(line: string): string {
  const pathPart = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renameIndex = pathPart.lastIndexOf(" -> ");
  const currentPath =
    renameIndex >= 0 ? pathPart.slice(renameIndex + 4) : pathPart;

  return unquotePorcelainPath(currentPath);
}

function porcelainLineReferencesPath(line: string, relPath: string): boolean {
  const changedPath = porcelainLinePath(line);

  return changedPath === relPath || changedPath.startsWith(`${relPath}/`);
}

export type DirtyWatchdogVerdict =
  | { dirty: false }
  | { dirty: true; porcelain: string };

// ADR-090 L3: verify the no-write invariant for a repo_read run against the
// parent checkout. The launch-time clean-baseline precondition makes any
// remaining dirt attributable.
export async function checkRepoReadDirt(
  repoPath: string,
  runId: string,
): Promise<DirtyWatchdogVerdict> {
  const packageMaterializationPaths = await agentMaterializationPathsForRun(
    repoPath,
    runId,
  );

  await restoreAgentMaterialization(repoPath, runId).catch((err: unknown) => {
    log.warn(
      { repoPath, err: err instanceof Error ? err.message : String(err) },
      "L2 restore failed — porcelain filter still excludes manifest paths",
    );
  });

  const porcelain = await statusPorcelain({ worktreePath: repoPath });
  const meaningful = filterManifestPorcelain(
    porcelain,
    packageMaterializationPaths,
  );

  if (meaningful === "") return { dirty: false };

  return { dirty: true, porcelain: meaningful };
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
