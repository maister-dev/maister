import { isMaisterError, MaisterError } from "@/lib/errors";

/** Manager-only preflight deferral: this attempt has not sent a create POST. */
export class SessionInventoryPending extends MaisterError {
  readonly runId: string;

  constructor(runId: string, cause: unknown) {
    super(
      "EXECUTOR_UNAVAILABLE",
      "Session creation is waiting for a confirmed host ownership inventory; reconcile or upgrade the original host",
      { cause, details: { reason: "session_inventory_pending", runId } },
    );
    this.runId = runId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPendingSessionInventory(error: unknown): boolean {
  return (
    isMaisterError(error) &&
    error.code === "EXECUTOR_UNAVAILABLE" &&
    (error.details?.reason === "session_inventory_unproven" ||
      error.details?.reason === "session_create_exit_unconfirmed" ||
      error.details?.reason === "session_process_owner_unconfirmed" ||
      error.details?.transport === "unknown_outcome")
  );
}
