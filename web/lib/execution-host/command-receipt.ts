import type { CommandReceipt } from "./contracts";

import { parseCommandReceiptV2 } from "../../../runtime/command-evidence";

/** Preserve the complete wire evidence alongside the common internal view. */
export function normalizeCommandReceiptV2(value: unknown): CommandReceipt {
  const receipt = parseCommandReceiptV2(value);

  return {
    evidenceV2: receipt,
    commandId: receipt.commandId,
    kind: receipt.kind,
    runId: receipt.runId,
    assignmentEpoch: receipt.assignmentEpoch,
    phase: receipt.phase,
    httpStatus: receipt.httpStatus,
    body: receipt.terminal?.result ?? receipt.terminal?.error ?? {},
    eventId: receipt.terminal?.eventId ?? null,
    receivedAt: receipt.receivedAt,
    completedAt: null,
    inflight: false,
  };
}
