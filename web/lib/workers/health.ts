import "server-only";

// The read side of the durable-worker slots, deliberately kept free of every
// domain import. `runtime.ts` imports this module; never the reverse. That
// direction is what lets a consumer (today the `system_sweep` summary, later
// the lag/backlog surface) report worker health without pulling the flow
// runner, the agent stack or `lib/execution-host` into its module graph — the
// cycle that makes a mocked suite fail as SKIPS rather than as errors.
//
// The three slots are interned symbols rather than plain globals because Next
// bundles instrumentation separately from the production server entrypoint:
// the writer resolves `runtime.ts` from the instrumentation bundle and this
// reader resolves from whichever bundle imported it, so a module-scoped
// variable would not be shared. `server-lifecycle.ts` documents the same
// constraint for the lifecycle callbacks.

export type DurableWorkerName =
  | "promptOwner"
  | "flowContinuation"
  | "agentContinuation";

export type DurableWorkerState = Readonly<{
  state: "running" | "degraded" | "stopped";
  reason: string | null;
}>;

/** The structural shape all three workers already expose. Declared locally —
 * importing the type would drag its domain module into this graph. */
export type DurableWorkerHandle = Readonly<{
  stop: () => Promise<void>;
  health: () => {
    state: "running" | "degraded" | "stopped";
    reason: string | null;
  };
}>;

export const DURABLE_WORKER_SLOT_KEYS: Readonly<
  Record<DurableWorkerName, symbol>
> = {
  promptOwner: Symbol.for("maister.durable-workers.promptOwner.v1"),
  flowContinuation: Symbol.for("maister.durable-workers.flowContinuation.v1"),
  agentContinuation: Symbol.for("maister.durable-workers.agentContinuation.v1"),
};

type SlotGlobal = typeof globalThis &
  Record<symbol, DurableWorkerHandle | undefined>;

export function readDurableWorkerSlot(
  name: DurableWorkerName,
): DurableWorkerHandle | undefined {
  return (globalThis as SlotGlobal)[DURABLE_WORKER_SLOT_KEYS[name]];
}

export function writeDurableWorkerSlot(
  name: DurableWorkerName,
  handle: DurableWorkerHandle | undefined,
): void {
  (globalThis as SlotGlobal)[DURABLE_WORKER_SLOT_KEYS[name]] = handle;
}

const STOPPED: DurableWorkerState = { state: "stopped", reason: null };

/** Each worker's own `health()`, or `stopped` for an empty slot. A worker that
 * throws from `health()` is reported degraded rather than propagating into the
 * caller's tick. */
export function durableWorkersHealth(): Readonly<
  Record<DurableWorkerName, DurableWorkerState>
> {
  const read = (name: DurableWorkerName): DurableWorkerState => {
    const handle = readDurableWorkerSlot(name);

    if (!handle) return STOPPED;
    try {
      const { state, reason } = handle.health();

      return { state, reason };
    } catch (error) {
      return {
        state: "degraded",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    promptOwner: read("promptOwner"),
    flowContinuation: read("flowContinuation"),
    agentContinuation: read("agentContinuation"),
  };
}
