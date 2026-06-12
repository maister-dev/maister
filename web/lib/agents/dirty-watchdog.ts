import "server-only";

import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { atomicWriteText } from "@/lib/atomic";
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

// ADR-088 L2 (materialize-only, ADR-041 boundary unchanged): instructed
// deny rules for write-class tools. Best-effort instruction for well-behaved
// agents; L1 (readOnlySession) and L3 (this watchdog) are the real layers.
const READ_ONLY_SETTINGS = `${JSON.stringify(
  {
    permissions: {
      deny: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"],
    },
  },
  null,
  2,
)}\n`;

export function agentMaterializationManifest(cwd: string): string[] {
  return [path.join(cwd, SETTINGS_RELATIVE), path.join(cwd, MARKER_RELATIVE)];
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
): Promise<{ materialized: boolean }> {
  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  const markerPath = path.join(cwd, MARKER_RELATIVE);

  if ((await fileExists(settingsPath)) && !(await fileExists(markerPath))) {
    log.warn(
      { cwd },
      "L2 skipped — user-owned .claude/settings.local.json present",
    );

    return { materialized: false };
  }

  await atomicWriteText(settingsPath, READ_ONLY_SETTINGS);
  await atomicWriteText(markerPath, "maister-owned\n");
  log.info({ cwd }, "L2 read-only settings materialized");

  return { materialized: true };
}

// Removes exactly the manifest-tracked files (only when our marker is
// present). Idempotent — safe to call at every terminal pass.
export async function restoreAgentMaterialization(cwd: string): Promise<void> {
  const markerPath = path.join(cwd, MARKER_RELATIVE);

  if (!(await fileExists(markerPath))) return;

  for (const p of agentMaterializationManifest(cwd)) {
    await rm(p, { force: true });
  }
  log.info({ cwd }, "L2 materialization restored");
}

// Drops porcelain lines that name manifest-tracked paths — the watchdog
// never attributes our own materialization as agent dirt (belt for the
// restore above).
export function filterManifestPorcelain(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter(
      (line) =>
        line.trim() !== "" &&
        !line.includes(SETTINGS_RELATIVE) &&
        !line.includes(MARKER_RELATIVE),
    )
    .join("\n");
}

export type DirtyWatchdogVerdict =
  | { dirty: false }
  | { dirty: true; porcelain: string };

// ADR-088 L3: verify the no-write invariant for a repo_read run against the
// parent checkout. The launch-time clean-baseline precondition makes any
// remaining dirt attributable.
export async function checkRepoReadDirt(
  repoPath: string,
): Promise<DirtyWatchdogVerdict> {
  await restoreAgentMaterialization(repoPath).catch((err: unknown) => {
    log.warn(
      { repoPath, err: err instanceof Error ? err.message : String(err) },
      "L2 restore failed — porcelain filter still excludes manifest paths",
    );
  });

  const porcelain = await statusPorcelain({ worktreePath: repoPath });
  const meaningful = filterManifestPorcelain(porcelain);

  if (meaningful === "") return { dirty: false };

  return { dirty: true, porcelain: meaningful };
}

// The quarantine transaction (ADR-088): agent flag + reason, plus — when the
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
): Promise<{ workspace: string; repoPath: string } | null> {
  const agentRows = await db
    .select({ workspace: agents.workspace })
    .from(agents)
    .where(eq(agents.id, agentId));
  const projectRows = await db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!agentRows[0] || !projectRows[0]) return null;

  return {
    workspace: agentRows[0].workspace as string,
    repoPath: projectRows[0].repoPath as string,
  };
}
