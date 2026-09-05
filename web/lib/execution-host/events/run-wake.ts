import "server-only";

import { EventEmitter } from "node:events";

// Wakeups are deliberately advisory. Every reader replays PostgreSQL after a
// wake (and after its bounded timeout), so an event emitted by another web
// process or lost during a restart cannot lose durable stream history.
class RunEventWakeBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  wake(runId: string): void {
    this.emitter.emit(runId);
  }

  wait(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const listener = () => cleanup();
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        this.emitter.off(runId, listener);
        signal?.removeEventListener("abort", cleanup);
        resolve();
      };

      if (signal?.aborted) {
        resolve();

        return;
      }
      this.emitter.once(runId, listener);
      signal?.addEventListener("abort", cleanup, { once: true });
      timeout = setTimeout(cleanup, timeoutMs);
    });
  }

  waiterCount(runId: string): number {
    return this.emitter.listenerCount(runId);
  }
}

declare global {
  var __maisterRunEventWakeBus: RunEventWakeBus | undefined;
}

export const runEventWakeBus: RunEventWakeBus =
  globalThis.__maisterRunEventWakeBus ?? new RunEventWakeBus();

globalThis.__maisterRunEventWakeBus = runEventWakeBus;
