// Next.js 16+ instrumentation hook — runs once per server process boot
// (Node runtime only, NOT the edge runtime). M8 T6 wires the
// keep-alive sweeper here so the singleton timer starts on the first
// request without any explicit kick. HMR-safe because the sweeper
// stores its handle on globalThis.
//
// M8 Codex review fix #2: also runs the resume-recovery sweep BEFORE
// the keep-alive sweeper. This catches claimed-but-undelivered HITL
// intents stranded across a web-process restart (the /respond idle
// branch returns 202 based on a queueMicrotask that may not survive a
// restart). The sweep is bounded and idempotent — a second invocation
// finds no matching rows. Failure during recovery is logged but does
// not block boot.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { runResumeRecoverySweep, runTakeoverReturnRecoverySweep } =
      await import("@/lib/runs/resume-recovery");

    await runResumeRecoverySweep();

    // M11b F3 (ADR-030 invariant 6): recover takeover-return runs stranded in
    // `Running` (process died after the AFTER-side flip, before the runner
    // attached) by an idempotent re-dispatch at runs.current_step_id. CAS-guarded
    // → a live runner makes this a no-op.
    await runTakeoverReturnRecoverySweep();

    // M19 Phase 2 (T2.3): startup reconcile — runs AFTER the two recovery
    // sweeps so their candidate sets are already handled; the reconcile sweep
    // excludes the takeover-return set to stay disjoint. Allow-list Running-only.
    const { runReconcileSweep } = await import("@/lib/reconcile");

    await runReconcileSweep();

    // ADR-106 (migration 0062): the per-flow → per-package agent re-key wipes
    // the `agents` catalog; re-project it from installed packages on boot so a
    // deploy that ran the migration repopulates without waiting for the next
    // package install. Idempotent (newest-Installed-per-name projection) — a
    // normal boot re-syncs to the same rows.
    const { resyncAgents } = await import("@/lib/agents/registry");

    await resyncAgents();

    // ADR-022/ADR-038: idempotent boot catch-up so event-stream evidence is
    // projected before any run is viewed (deterministic-PK upsert → no dups).
    const { runProjectorCatchUpSweep } = await import(
      "@/lib/projector/catch-up-sweep"
    );

    await runProjectorCatchUpSweep();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[instrumentation] recovery sweeps failed (continuing boot):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { startKeepaliveSweeper } = await import(
    "@/lib/runs/keepalive-sweeper"
  );

  startKeepaliveSweeper();

  const { startReconcileSweeper } = await import("@/lib/reconcile");

  startReconcileSweeper();

  const { startGcSweeper } = await import("@/lib/gc/sweeper");

  startGcSweeper();

  const { startSchedulerTimer } = await import("@/lib/scheduler/timer");

  startSchedulerTimer();

  // ADR-088: fire-and-forget package bootstrap — first ensure the env-driven
  // default package source row(s) exist (insert-only, idempotent, honors admin
  // disable; MAISTER_DEFAULT_PACKAGE_SOURCES), then refresh enabled sources
  // whose snapshot is older than MAISTER_PACKAGE_DISCOVERY_STALE_HOURS
  // (default 24). Ensuring before the sweep lets freshly-seeded rows
  // (lastCheckedAt === null) be picked up on the same boot. Sequential,
  // per-source try/catch; failures degrade to the cached snapshot.
  void import("@/lib/packages/catalog")
    .then(async ({ ensureDefaultPackageSources, refreshStaleSources }) => {
      await ensureDefaultPackageSources();
      await refreshStaleSources();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        "[instrumentation] package discovery sweep failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
}
