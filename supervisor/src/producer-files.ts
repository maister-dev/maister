import type { HostState } from "./host-state";

import { dirname, join } from "node:path";

import { HostRuntimeEventError } from "./host-runtime-errors";

export type ProducerFiles = {
  spoolPath: string;
  tryReserveLogBytes: (bytes: number) => boolean;
  reserveTeardownLogBytes: (bytes: number) => void;
  recordLogBytes: (bytes: number) => void;
  recordSpoolBytes: (bytes: number) => void;
  finish: () => void;
  abandonUnstarted: () => void;
};

/** Reserves the reusable spool before spawning; raw-log growth is write-driven. */
export function prepareProducerFiles(input: {
  state: HostState;
  walletId: string;
  sessionId: string;
  logPath: string;
}): ProducerFiles {
  const { state, walletId, sessionId, logPath } = input;
  const logId = `log:${sessionId}`;
  const spoolId = `spool:${sessionId}`;
  const spoolPath = join(dirname(logPath), `.acp-frame-${sessionId}.tmp`);
  let logBytes = 0;

  state.reserveRuntimeFile(
    {
      fileId: logId,
      privatePath: logPath,
      temporaryPath: null,
      kind: "log",
      walletId,
      capacityBytes: 0,
      writtenBytes: 0,
      sealed: false,
    },
    { kind: "producer", walletId },
  );
  state.reserveRuntimeFile(
    {
      fileId: spoolId,
      privatePath: spoolPath,
      temporaryPath: null,
      kind: "spool",
      walletId,
      capacityBytes: 2 * 1024 * 1024,
      writtenBytes: 0,
      sealed: false,
    },
    { kind: "wallet", walletId },
  );

  const finish = (): void => {
    if (!state.runtimeStorageAvailable()) return;
    state.releaseRuntimeFile(spoolId);
    state.sealRuntimeFile(logId, logBytes);
  };

  return {
    spoolPath,
    tryReserveLogBytes(bytes) {
      try {
        state.growRuntimeFile(logId, bytes, { kind: "producer", walletId });

        return true;
      } catch (error) {
        if (
          error instanceof HostRuntimeEventError &&
          error.reason === "runtime_storage_pressure" &&
          state.getReceipt(walletId)?.phase !== "accepted"
        )
          return false;
        throw error;
      }
    },
    reserveTeardownLogBytes(bytes) {
      state.growRuntimeFile(logId, bytes, { kind: "wallet", walletId });
    },
    recordLogBytes(bytes) {
      logBytes += bytes;
      state.recordRuntimeFileBytes(logId, logBytes);
    },
    recordSpoolBytes(bytes) {
      state.recordRuntimeFileBytes(spoolId, bytes);
    },
    finish,
    abandonUnstarted: finish,
  };
}
