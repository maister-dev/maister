import type { HostState } from "./host-state";
import type { ProducerFiles } from "./producer-files";
import type { SessionRecord } from "./types";

export type LogWriteAdmission = { kind: "capture" } | { kind: "drain" };

export type FrameAdmission =
  | { kind: "decode"; release: () => void }
  | { kind: "drain" };

/** Capacity wakeups come from committed ACK/prune/release transitions. */
export function producerPressure(
  state: HostState,
  record: SessionRecord,
  files?: ProducerFiles,
): {
  beforeFrame: (frameBytes: number) => Promise<FrameAdmission>;
  beforeWrite: (bytes: number) => Promise<LogWriteAdmission>;
  beginTeardown: () => void;
  shouldDrain: () => boolean;
} {
  let stopping = false;
  let wake: (() => void) | undefined;

  const waitForCapacity = <T>(
    allocate: () => T | null,
    stoppedValue: () => T,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      let attempting = false;
      let settled = false;
      let unsubscribe = (): void => {};
      const cleanup = (): void => {
        settled = true;
        record.outputPaused = false;
        unsubscribe();
        wake = undefined;
      };
      const attempt = (): void => {
        if (attempting || settled) return;
        attempting = true;
        try {
          const value = allocate();

          if (value !== null) {
            cleanup();
            resolve(value);
          } else if (stopping) {
            const final = stoppedValue();

            cleanup();
            resolve(final);
          } else record.outputPaused = true;
        } catch (error) {
          cleanup();
          reject(error);
        } finally {
          attempting = false;
        }
      };

      wake = attempt;
      unsubscribe = state.subscribeRuntimeCapacity(attempt);
      attempt();
    });

  return {
    beforeFrame(frameBytes) {
      return waitForCapacity<FrameAdmission>(
        () => {
          const reservationId = state.tryReserveRuntimeFrame(
            record.createdByCommandId,
            frameBytes,
          );

          if (!reservationId) return null;
          record.outputEventReservationId = reservationId;

          return {
            kind: "decode",
            release: () => {
              record.outputEventReservationId = undefined;
              state.releaseRuntimeFrame(reservationId);
            },
          };
        },
        () => ({ kind: "drain" }),
      );
    },
    beforeWrite(bytes) {
      return waitForCapacity<LogWriteAdmission>(
        () =>
          !files || files.tryReserveLogBytes(bytes)
            ? { kind: "capture" }
            : null,
        () => {
          files?.reserveTeardownLogBytes(bytes);

          return { kind: "drain" };
        },
      );
    },
    beginTeardown() {
      stopping = true;
      wake?.();
    },
    shouldDrain() {
      return stopping && state.runtimeEventOutboxStats().budget.pressured;
    },
  };
}
