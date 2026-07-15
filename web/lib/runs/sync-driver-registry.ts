import "server-only";

// ADR-138 (Task 11) — the in-process sync-driver registry.
//
// `syncRunTarget` (mechanical + agent conflict resolver) runs the WHOLE branch
// sync in-process. While that call is on the stack the run has a live in-process
// driver; after a Next.js/web restart the registry is EMPTY, so a run left with a
// non-terminal `run_sync_attempts` row and no registered driver is an ORPHAN.
//
// This membership is the skip-vs-abort discriminant recovery keys on:
//   - reconcile (agent path, run `Running`): a live supervisor session WITH a
//     registered driver is healthy → SKIP; WITHOUT one (post-restart) it is an
//     orphaned session → W2 abort.
//   - the system sweep (mechanical path, run `Review`): a `starting`/`rebasing`
//     attempt WITH a registered driver is a live in-flight rebase → leave it;
//     WITHOUT one it is a W1/W4 orphan → abort.
//
// The set is process-scoped by design (a driver only ever runs in one process);
// it is intentionally NOT durable — a restart clears it, which is precisely how a
// post-restart orphan is detected. Held on a global symbol so a duplicated
// module instance (server/edge bundles) shares one set.

const REGISTRY_KEY = Symbol.for("maister.sync-driver-registry.v1");

function registry(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;

  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Set<string>();
  }

  return g[REGISTRY_KEY]!;
}

// Mark `runId` as driven by a live in-process sync operation. Called at the start
// of `syncRunTarget` (covering both the mechanical rebase and, transitively, the
// agent resolver session it spawns) and removed in its `finally`.
export function registerSyncDriver(runId: string): void {
  registry().add(runId);
}

export function unregisterSyncDriver(runId: string): void {
  registry().delete(runId);
}

// True iff a live in-process sync driver owns `runId` in THIS process.
export function hasSyncDriver(runId: string): boolean {
  return registry().has(runId);
}

// Test-only: the current membership snapshot (never used by production paths).
export function activeSyncDriverRunIds(): string[] {
  return [...registry()];
}
