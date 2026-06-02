import "server-only";

import pino from "pino";

import {
  runRevisionGcSweep,
  type RevisionGcSummary,
} from "@/lib/gc/revision-gc";
import {
  runWorkspaceGcSweep,
  type WorkspaceGcSummary,
} from "@/lib/gc/workspace-gc";
import { gcSweepIntervalSeconds } from "@/lib/instance-config";

const log = pino({
  name: "gc-sweeper",
  level: process.env.LOG_LEVEL ?? "info",
});

export type GcSweepsResult = {
  workspace: WorkspaceGcSummary;
  revision: RevisionGcSummary;
};

// Run both GC sweeps. Each is wrapped so one failure does not abort the other —
// the workspace sweep and the revision sweep are independent.
export async function runGcSweeps(): Promise<GcSweepsResult> {
  const [workspaceSettled, revisionSettled] = await Promise.allSettled([
    runWorkspaceGcSweep(),
    runRevisionGcSweep(),
  ]);

  if (workspaceSettled.status === "rejected") {
    log.error(
      {
        err:
          workspaceSettled.reason instanceof Error
            ? workspaceSettled.reason.message
            : String(workspaceSettled.reason),
      },
      "workspace GC sweep threw",
    );
  }
  if (revisionSettled.status === "rejected") {
    log.error(
      {
        err:
          revisionSettled.reason instanceof Error
            ? revisionSettled.reason.message
            : String(revisionSettled.reason),
      },
      "revision GC sweep threw",
    );
  }

  return {
    workspace:
      workspaceSettled.status === "fulfilled"
        ? workspaceSettled.value
        : {
            scanned: 0,
            preserved: 0,
            pruned: 0,
            skippedUnpreserved: 0,
            failed: 0,
          },
    revision:
      revisionSettled.status === "fulfilled"
        ? revisionSettled.value
        : { scanned: 0, deleted: 0, skippedReferenced: 0, failed: 0 },
  };
}

// Singleton on globalThis so Next.js HMR does not multiply timers. Mirrors
// startKeepaliveSweeper / startReconcileSweeper.
type GlobalGcSweeperState = {
  handle: NodeJS.Timeout | null;
  intervalSeconds: number;
};

const GC_GLOBAL_KEY = Symbol.for("maister.gc-sweeper.v1");

function globalState(): GlobalGcSweeperState {
  const g = globalThis as unknown as Record<symbol, GlobalGcSweeperState>;

  if (!g[GC_GLOBAL_KEY]) {
    g[GC_GLOBAL_KEY] = { handle: null, intervalSeconds: 0 };
  }

  return g[GC_GLOBAL_KEY];
}

export function startGcSweeper(): void {
  const state = globalState();
  const intervalSeconds = gcSweepIntervalSeconds();

  if (state.handle) {
    if (state.intervalSeconds === intervalSeconds) {
      log.debug(
        { intervalSeconds },
        "startGcSweeper: already running with the same interval — no-op",
      );

      return;
    }
    log.info(
      { prevIntervalSeconds: state.intervalSeconds, intervalSeconds },
      "startGcSweeper: interval changed — restarting timer",
    );
    clearInterval(state.handle);
    state.handle = null;
  }

  state.intervalSeconds = intervalSeconds;
  state.handle = setInterval(() => {
    void runGcSweeps().catch((err: unknown) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "GC sweep tick threw — continuing on next interval",
      );
    });
  }, intervalSeconds * 1_000);
  state.handle.unref?.();
  log.info({ intervalSeconds }, "gc-sweeper started");
}

export function stopGcSweeper(): void {
  const state = globalState();

  if (state.handle) {
    clearInterval(state.handle);
    state.handle = null;
    log.info({}, "gc-sweeper stopped");
  }
}
