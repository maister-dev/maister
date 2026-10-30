import "server-only";

import type { ContextMountSnapshot } from "@/lib/context-mounts/types";

import { lstat } from "node:fs/promises";

import { eq } from "drizzle-orm";
import pino from "pino";

import { quarantineAgentInTx } from "@/lib/agents/dirty-watchdog";
import { releaseContextMounts } from "@/lib/context-mounts/service";
import { MaisterError } from "@/lib/errors";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { statusPorcelain } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/context-mounts/service.ts).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "context-mounts-terminal",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-157: a run in any of these still holds its mounts open. Anything OUTSIDE
// the set — or a missing `runs` row — means the terminal choke already ran or
// never will, so the mounts are reapable. `Review` is IN the set because a
// `Review` flow run can rework and re-open a session that still expects them.
//
// DEVIATION from reconciliation-gc.md's enumerated list, deliberately: it omits
// `WaitingOnChildren`, but a parked orchestrator is the `Review` case in its
// strongest form — it WILL be woken by a child-terminal event and resumed via
// session/resume into the same node. Reaping its mounts mid-park would hand the
// resumed coordinator paths that no longer exist. Reconcile the doc to this list.
export const CONTEXT_MOUNT_LIVE_RUN_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
] as const;

export function isContextMountLiveRunStatus(status: string): boolean {
  return (CONTEXT_MOUNT_LIVE_RUN_STATUSES as readonly string[]).includes(
    status,
  );
}

export type ContextMountDirtVerdict =
  | { kind: "clean" }
  | { kind: "gone" }
  | { kind: "dirty"; porcelain: string }
  | { kind: "indeterminate"; error: string };

// ADR-157 L3: the mount is `git worktree add --detach`ed, so its `.git` is a
// FILE pointing into the SIBLING's `.git/worktrees/<name>` — an escaped write
// could touch the donor repo's metadata, not just a throwaway checkout. Hence a
// dirty mount is evidence of an L2 bypass and is reported even though the
// checkout itself is about to be discarded.
export async function checkContextMountDirt(
  mountPath: string,
): Promise<ContextMountDirtVerdict> {
  // The snapshot is provenance and is NEVER cleared, so a second release call
  // (runGraph Failed followed by an operator abandon, say) sees the same entries
  // against an already-removed path. Without this arm `git status` would throw
  // and be reported as `indeterminate` — a spurious L3 violation, and on an
  // agent-driven run a spurious quarantine.
  try {
    await lstat(mountPath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { kind: "gone" };

    return {
      kind: "indeterminate",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let porcelain: string;

  try {
    porcelain = await statusPorcelain({ worktreePath: mountPath });
  } catch (err) {
    return {
      kind: "indeterminate",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const meaningful = porcelain
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n");

  return meaningful === ""
    ? { kind: "clean" }
    : { kind: "dirty", porcelain: meaningful };
}

export type ReleaseRunContextMountsResult = {
  released: number;
  dirty: number;
  skippedLive: boolean;
};

/**
 * ADR-157 T32 terminal choke. Reads the LAUNCH SNAPSHOT off
 * `runs.context_mounts` — never the manifest or the attachment, either of which
 * can change after launch and point cleanup at paths this run never created.
 *
 * Status-gated on the same live allow-list the GC backstop uses, so every call
 * site can invoke it unconditionally after its own terminal write: a run still
 * in the live set (a `pull_request` promotion that stays in `Review`, a parked
 * orchestrator) is skipped, and a genuinely terminal one is released exactly
 * once. Idempotent — `removeWorktree` no-ops on an already-gone path.
 *
 * Code-delivery removal proceeds even when L3 finds dirt: the mount is detached with no
 * branch, so nothing that was ever legitimate is lost.
 */
export async function releaseRunContextMounts(args: {
  runId: string;
  db?: Db;
}): Promise<ReleaseRunContextMountsResult> {
  const db = args.db ?? getDb();
  const rows = (await db
    .select({
      status: runs.status,
      agentKind: runs.agentKind,
      contextMounts: runs.contextMounts,
      agentId: runs.agentId,
      projectId: runs.projectId,
      taskId: runs.taskId,
    })
    .from(runs)
    .where(eq(runs.id, args.runId))) as Array<{
    status: string;
    agentKind: string | null;
    contextMounts: ContextMountSnapshot[] | null;
    agentId: string | null;
    projectId: string | null;
    taskId: string | null;
  }>;
  const run = rows[0];
  const snapshot = run?.contextMounts ?? [];

  if (!run || snapshot.length === 0) {
    return { released: 0, dirty: 0, skippedLive: false };
  }

  if (isContextMountLiveRunStatus(run.status)) {
    log.debug(
      { runId: args.runId, status: run.status },
      "context mount release skipped — run is still live",
    );

    return { released: 0, dirty: 0, skippedLive: true };
  }

  if (run.agentKind === "operational")
    throw new MaisterError(
      "PRECONDITION",
      "Operational context cleanup must use the evidence-preserving disposition owner",
      { details: { reason: "operational_context_owner_required" } },
    );

  let dirty = 0;

  for (const mount of snapshot) {
    const verdict = await checkContextMountDirt(mount.mountPath);

    if (verdict.kind === "clean" || verdict.kind === "gone") continue;

    dirty += 1;

    const violation =
      verdict.kind === "dirty"
        ? verdict.porcelain.slice(0, 512)
        : `dirt check indeterminate: ${verdict.error.slice(0, 512)}`;

    log.warn(
      {
        runId: args.runId,
        siblingSlug: mount.slug,
        mountPath: mount.mountPath,
        committish: mount.committish,
        porcelain: violation,
      },
      "[FIX:context-mount-dirty] read-only context mount was written to — L2 bypassed",
    );

    // Quarantine evidence in the ADR-090 dirty-watchdog shape (one transaction:
    // agent flag + reason, plus the system comment + activity entry when the run
    // is task-bound). A flow run with no driving agent has no catalog row to
    // flag, so the WARN above is the whole record for that case.
    if (run.agentId && run.projectId) {
      await db
        .transaction(async (tx: Db) => {
          await quarantineAgentInTx({
            tx,
            agentId: run.agentId as string,
            runId: args.runId,
            projectId: run.projectId as string,
            taskId: run.taskId,
            reason: `read-only context mount "${mount.slug}" at ${mount.mountPath} was modified: ${violation}`,
          });
        })
        .catch((err: unknown) => {
          log.error(
            {
              runId: args.runId,
              siblingSlug: mount.slug,
              err: err instanceof Error ? err.message : String(err),
            },
            "context mount quarantine evidence write failed",
          );
        });
    }
  }

  const removal = await releaseContextMounts(snapshot);

  log.info(
    {
      runId: args.runId,
      status: run.status,
      released: removal.released,
      dirty,
    },
    "context mounts released at the terminal choke",
  );

  return { released: removal.released, dirty, skippedLive: false };
}

/** Called only by operational disposition, after immutable ownership and evidence checks. */
export async function releaseOperationalContextMounts(args: {
  runId: string;
  mounts: ContextMountSnapshot[];
}): Promise<void> {
  const snapshot = args.mounts;
  const removal = await releaseContextMounts(snapshot);

  if (removal.failures.length > 0)
    throw new MaisterError(
      "PRECONDITION",
      "Context worktree cleanup failed; resolve the reported Git error and retry cleanup",
      {
        details: {
          reason: "operational_context_cleanup_failed",
          failures: removal.failures,
        },
      },
    );

  for (const mount of snapshot) {
    try {
      await lstat(mount.mountPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        continue;
      throw error;
    }
    throw new MaisterError(
      "PRECONDITION",
      "Operational context bytes remain after Git removal; diagnose the checkout and retry cleanup",
      {
        details: {
          reason: "operational_context_cleanup_failed",
          siblingProjectId: mount.projectId,
        },
      },
    );
  }

  log.info(
    { runId: args.runId, released: removal.released },
    "[FIX:operational-context] context bytes removed after evidence preservation",
  );
}
