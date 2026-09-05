import type { HostState } from "./host-state";
import type { SessionRecord } from "./types";

export type FrameAdmission =
  | { kind: "decode"; release: () => void }
  | { kind: "drain" };

/** Capacity wakeups come from committed ACK/prune/release transitions. */
export function producerPressure(
  state: HostState,
  record: SessionRecord,
): {
  beforeFrame: () => Promise<FrameAdmission>;
  beginTeardown: () => void;
  shouldDrain: () => boolean;
} {
  let stopping = false;
  let wake: (() => void) | undefined;

  return {
    beforeFrame() {
      return new Promise((resolve, reject) => {
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
            const reservationId = state.tryReserveRuntimeFrame(
              record.createdByCommandId,
            );

            if (reservationId) {
              cleanup();
              record.outputEventReservationId = reservationId;
              resolve({
                kind: "decode",
                release: () => {
                  record.outputEventReservationId = undefined;
                  state.releaseRuntimeFrame(reservationId);
                },
              });
            } else if (stopping) {
              cleanup();
              resolve({ kind: "drain" });
            } else {
              record.outputPaused = true;
            }
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
