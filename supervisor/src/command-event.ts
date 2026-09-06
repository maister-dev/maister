import type { CommandReceiptRow, HostState } from "./host-state";
import type { CommandEventPayloadV2 } from "../../runtime/command-evidence";

import { parseCommandEventPayloadV2 } from "../../runtime/command-evidence";

import { receiptToResponse } from "./command-receipts";
import { deterministicRuntimeEventId } from "./runtime-events";
import { SupervisorError } from "./types";

/** Called synchronously before the matching SQLite append. Both live and
 * restart terminalization derive exactly the same native evidence payload.
 */
export function commandReceiptPayloadV2(
  row: CommandReceiptRow,
  state: HostState,
  metadata: {
    sourceMonotonicId?: number;
    sessionName?: string;
    nodeAttemptId?: string;
  } = {},
): CommandEventPayloadV2 {
  const position = state.nextRuntimeEventPosition();
  const eventId = deterministicRuntimeEventId({
    hostKey: state.hostKey,
    ...position,
  });
  const receipt = receiptToResponse(
    {
      ...row,
      eventId,
      terminalStreamId: position.streamId,
      terminalSequence: position.sequence,
    },
    false,
  );

  if (!("receiptVersion" in receipt)) {
    throw new SupervisorError(
      "ACP_PROTOCOL",
      "command event v2 requires a native v2 receipt",
    );
  }

  return parseCommandEventPayloadV2(
    {
      ...metadata,
      commandId: row.commandId,
      kind: row.kind,
      phase: row.phase,
      sourceCommandId: row.commandId,
      requestSchema: receipt.requestSchema,
      requestSha256: receipt.requestSha256,
      terminal: receipt.terminal,
    },
    { ...position, eventId, hostSessionId: row.hostSessionId },
  );
}
