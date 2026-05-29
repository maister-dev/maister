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
    const { runResumeRecoverySweep } = await import(
      "@/lib/runs/resume-recovery"
    );

    await runResumeRecoverySweep();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[instrumentation] resume-recovery sweep failed (continuing boot):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { startKeepaliveSweeper } = await import(
    "@/lib/runs/keepalive-sweeper"
  );

  startKeepaliveSweeper();
}
