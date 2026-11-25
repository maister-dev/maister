export interface CoalescedRefresherOptions {
  intervalMs: number;
  run: (signal: AbortSignal) => Promise<void> | void;
}

export interface CoalescedRefresher {
  trigger: () => void;
  dispose: () => void;
}

// Leading-coalescing scheduler for SSE-driven refreshes: once a
// tick arrives, run executes after `intervalMs` even under continuous bursts,
// keeps any in-flight signal un-aborted on new ticks, and collapses triggers
// received while in-flight into a single follow-up run after settlement.
export function createCoalescedRefresher({
  intervalMs,
  run,
}: CoalescedRefresherOptions): CoalescedRefresher {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false;

  function schedule(): void {
    if (controller.signal.aborted) return;
    pending = true;
    if (timer !== null || inFlight) return;
    timer = setTimeout(() => {
      void flush();
    }, intervalMs);
  }

  async function flush(): Promise<void> {
    timer = null;
    pending = false;
    if (controller.signal.aborted) return;
    inFlight = true;

    try {
      await run(controller.signal);
    } catch {
      // Consumers handle their own errors; keep the scheduler alive.
    } finally {
      inFlight = false;
      if (pending && !controller.signal.aborted) schedule();
    }
  }

  function dispose(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    controller.abort();
  }

  return { trigger: schedule, dispose };
}
