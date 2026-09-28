import type {
  CommandReceiptRow,
  HostRuntimeObjectRow,
  HostState,
} from "./host-state";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { RuntimeObjectRegistry } from "./runtime-objects";
import type { Logger } from "pino";

import { HostRuntimeEventError } from "./host-runtime-errors";

type Disposition =
  | "completed"
  | "object_missing"
  | "fence_mismatch"
  | "unsealed"
  | "undeleted";

function dispositionFor(
  receipt: CommandReceiptRow,
  object: HostRuntimeObjectRow | null,
): Disposition {
  if (!object) return "object_missing";
  if (
    object.runId !== receipt.runId ||
    object.assignmentId !== receipt.assignmentId ||
    object.assignmentEpoch !== receipt.epoch
  )
    return "fence_mismatch";
  if (receipt.kind === "runtime_object.upload")
    return object.state === "available" &&
      object.sizeBytes !== null &&
      object.sha256 !== null
      ? "completed"
      : "unsealed";

  return object.state === "deleted" ? "completed" : "undeleted";
}

/** Settle accepted upload/delete receipts whose object effect committed before
 * a crash lost the completed receipt and its canonical event. The object row is
 * the intent that command already fenced; a row that never sealed or never
 * tombstoned settles nothing and its receipt stays accepted. */
export function completeRecoveredRuntimeObjectReceipts(input: {
  state: HostState;
  objects: RuntimeObjectRegistry;
  runtimeEvents: RuntimeEventPublisher;
  logger: Logger;
  now?: () => Date;
}): number {
  const now = input.now ?? (() => new Date());
  let completed = 0;
  let afterCommandId = "";

  for (;;) {
    const page = input.state.acceptedRuntimeObjectReceipts(afterCommandId, 100);

    if (page.length === 0) break;
    for (const receipt of page) {
      const object = input.state.getRuntimeObject(receipt.hostSessionId ?? "");
      const disposition = dispositionFor(receipt, object);
      const fields = {
        commandId: receipt.commandId,
        kind: receipt.kind,
        objectId: receipt.hostSessionId,
        generation: object?.generation ?? null,
        disposition,
      };

      if (disposition !== "completed" || !object) {
        input.logger.warn(fields, "runtime-object-receipt-left-accepted");
        continue;
      }
      const metadata = input.objects.metadata(object.id);

      try {
        input.state.putReceiptWithRuntimeEvent(
          {
            ...receipt,
            phase: "completed",
            httpStatus: receipt.kind === "runtime_object.upload" ? 200 : 204,
            body: metadata,
            completedAt: now().toISOString(),
          },
          input.runtimeEvents.runtimeObjectInput({
            runId: receipt.runId,
            assignmentId: object.assignmentId,
            assignmentEpoch: object.assignmentEpoch,
            metadata,
          }),
        );
      } catch (error) {
        // Outbox pressure defers the settlement to the next boot; the receipt
        // and the sealed row remain exactly as they were.
        if (!(error instanceof HostRuntimeEventError)) throw error;
        input.logger.warn(
          { ...fields, reason: error.reason },
          "runtime-object-receipt-recovery-deferred",
        );
        continue;
      }
      input.logger.info(fields, "runtime-object-receipt-recovered");
      completed += 1;
    }
    afterCommandId = page[page.length - 1].commandId;
  }

  return completed;
}
