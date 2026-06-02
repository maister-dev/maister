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
}
