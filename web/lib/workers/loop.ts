import "server-only";

import { AsyncResource } from "node:async_hooks";

/**
 * Run serial worker iterations without retaining process-lifetime async ancestry.
 * React Flight's development async hooks retain previous/awaited operations of
 * an endless async function, including idle database queries. Each iteration
 * therefore owns a detached async root and settles before the next is scheduled.
 * The returned promise joins in-flight work on abort and propagates failures.
 */
export function runWorkerLoop(
  signal: AbortSignal,
  work: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const iterate = (): void => {
      if (signal.aborted) {
        resolve();

        return;
      }
      const resource = new AsyncResource("maister-worker-iteration", {
        triggerAsyncId: 0,
        requireManualDestroy: true,
      });

      resource.runInAsyncScope(() => {
        Promise.resolve()
          .then(work)
          .then(
            () => {
              resource.emitDestroy();
              setImmediate(iterate);
            },
            (error: unknown) => {
              resource.emitDestroy();
              reject(error);
            },
          );
      });
    };

    iterate();
  });
}
