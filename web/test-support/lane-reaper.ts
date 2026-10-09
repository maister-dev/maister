import { getContainerRuntimeClient, getReaper } from "testcontainers";

export class LaneReaperUnavailableError extends Error {
  readonly name = "LaneReaperUnavailableError";
}

type RetainedLaneReaper = Readonly<{
  containerId: string;
  sessionId: string;
}>;

/**
 * The public Testcontainers reaper retains an unreferenced socket until this
 * owning runner exits. Acquire it before disposable workers so their death
 * cannot retire the shared reaper between cases. Returning from the lane does
 * not close this process lease; invocation cleanup runs before runner exit.
 */
export async function retainLaneReaper(
  ownerSignal: AbortSignal,
): Promise<RetainedLaneReaper> {
  const timeoutMs = Number(
    process.env.MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS ?? "30000",
  );

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new LaneReaperUnavailableError(
      "MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS must be an integer from 1 to 30000 for A/B reaper acquisition",
    );
  const acquisition = new AbortController();
  const ownerAborted = (): void =>
    acquisition.abort(
      new LaneReaperUnavailableError(
        "A/B runner reaper acquisition aborted before workers",
        { cause: ownerSignal.reason },
      ),
    );
  const timer = setTimeout(
    () =>
      acquisition.abort(
        new LaneReaperUnavailableError(
          `A/B runner reaper acquisition deadline expired after ${timeoutMs}ms`,
        ),
      ),
    timeoutMs,
  );
  let rejectAborted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(acquisition.signal.reason);
    acquisition.signal.addEventListener("abort", rejectAborted, { once: true });
  });

  ownerSignal.addEventListener("abort", ownerAborted, { once: true });
  if (ownerSignal.aborted) ownerAborted();
  const acquire = async (): Promise<RetainedLaneReaper> => {
    acquisition.signal.throwIfAborted();
    const client = await getContainerRuntimeClient();

    // Public runtime discovery has no cancellation API. A late resolution must
    // never start a new reaper after the owner/deadline has already rejected.
    acquisition.signal.throwIfAborted();
    const reaper = await getReaper(client);

    acquisition.signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/u.test(reaper.containerId))
      throw new LaneReaperUnavailableError(
        "A/B lanes require an enabled real Testcontainers reaper",
      );

    return { containerId: reaper.containerId, sessionId: reaper.sessionId };
  };

  try {
    return await Promise.race([acquire(), aborted]);
  } catch (cause) {
    if (cause instanceof LaneReaperUnavailableError) throw cause;
    throw new LaneReaperUnavailableError(
      "A/B runner could not retain the real Testcontainers reaper before starting workers",
      { cause },
    );
  } finally {
    clearTimeout(timer);
    ownerSignal.removeEventListener("abort", ownerAborted);
    if (rejectAborted)
      acquisition.signal.removeEventListener("abort", rejectAborted);
  }
}
