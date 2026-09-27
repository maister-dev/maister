import type { Logger } from "pino";
import type { HostState } from "./host-state";
import type { ProducerFiles } from "./producer-files";
import type { SessionRecord } from "./types";

export type LogWriteAdmission = { kind: "capture" } | { kind: "drain" };

export type FrameAdmission =
  | { kind: "decode"; release: () => void }
  | { kind: "drain" };

// ADR-183 D6: how long a producer may stay paused by outbox pressure before
// the host checkpoints it gracefully (ADR-180's teardown). One stall window;
// ≥ 7× the row-lane and ≈ 2× the byte-lane drain at the measured manager
// throughput. A code constant, not an operator setting.
export const PRODUCER_PAUSE_MAX_MS = 5 * 60_000;

export type ProducerPauseBound = {
  maxMs: number;
  // Called once, while the producer is still paused, not stopping, and the
  // outbox is what refuses its frames.
  onExceeded: (pausedMs: number) => void;
};

/** Capacity wakeups come from committed ACK/prune/release transitions. A
 * frame wait logs its pause and its resume once each (ADR-184 D6). */
export function producerPressure(
  state: HostState,
  record: SessionRecord,
  files?: ProducerFiles,
  pauseBound?: ProducerPauseBound,
  logger?: Logger,
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
    bounded: boolean,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      let attempting = false;
      let settled = false;
      let unsubscribe = (): void => {};
      let pauseTimer: NodeJS.Timeout | undefined;
      // A frame wait (`bounded`) that paused: one line when it pauses, one when
      // it ends, however many capacity wakes find nothing in between.
      let pausedAt: number | undefined;
      const cleanup = (): void => {
        settled = true;
        if (pausedAt !== undefined)
          logger?.info(
            {
              sessionId: record.sessionId,
              runId: record.runId,
              pausedMs: Date.now() - pausedAt,
            },
            "producer-output-resumed",
          );
        pausedAt = undefined;
        record.outputPaused = false;
        record.outputPausedSince = undefined;
        if (pauseTimer) clearTimeout(pauseTimer);
        pauseTimer = undefined;
        unsubscribe();
        wake = undefined;
      };
      // A pause the outbox did not cause (runtime-file or physical headroom)
      // keeps waiting as before; the bound re-arms instead of parking.
      const onPauseBound = (): void => {
        pauseTimer = undefined;
        if (settled || stopping || !record.outputPaused || !pauseBound) return;
        if (!state.runtimeEventOutboxRefusesFrames()) {
          armPauseBound();

          return;
        }
        pauseBound.onExceeded(
          Date.now() - (record.outputPausedSince ?? Date.now()),
        );
      };
      const armPauseBound = (): void => {
        if (!bounded || !pauseBound || pauseTimer || settled) return;
        record.outputPausedSince ??= Date.now();
        pauseTimer = setTimeout(onPauseBound, pauseBound.maxMs);
        pauseTimer.unref();
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
          } else {
            if (bounded && pausedAt === undefined) {
              pausedAt = Date.now();
              logger?.info(
                {
                  sessionId: record.sessionId,
                  runId: record.runId,
                  outboxRefusesFrames: state.runtimeEventOutboxRefusesFrames(),
                },
                "producer-output-paused",
              );
            }
            record.outputPaused = true;
            armPauseBound();
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
        true,
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
        false,
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
