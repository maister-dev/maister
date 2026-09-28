import "server-only";

import type { ScratchDialogStatus } from "@/lib/db/schema";
import type { SupervisorSessionRecord } from "@/lib/execution-host";

export type ScratchRecoveryAction =
  | "open"
  | "recover"
  | "discard_only"
  | "none"
  | "refuse";

/** A Recover is a CAS on `runs.status = 'Crashed'` (ADR-175 2026-09-26). Any
 * other status names why it is refused: `Failed` is a deliberate budget stop,
 * `NeedsInputIdle` resumes from the stored answer (`next: "respond"`), and a
 * live status with a dead host session is the reconcile sweep's to crash. */
export type ScratchRecoveryDecision =
  | Readonly<{ action: Exclude<ScratchRecoveryAction, "refuse"> }>
  | Readonly<{ action: "refuse"; status: string; next?: "respond" }>;

export type ScratchRecoveryInput = {
  runStatus: string;
  dialogStatus: ScratchDialogStatus;
  acpSessionId: string | null;
  hostSessionId: string | null;
  workspaceRemoved: boolean;
  liveHostSessionIds: ReadonlySet<string>;
};

export function liveScratchHostSessionIds(
  sessions: readonly SupervisorSessionRecord[],
): Set<string> {
  return new Set(
    sessions
      .filter((session) => session.status === "live")
      .map((session) => session.sessionId),
  );
}

export function classifyScratchRecovery(
  input: ScratchRecoveryInput,
): ScratchRecoveryDecision {
  if (input.workspaceRemoved) return { action: "none" };
  if (input.dialogStatus === "Done" || input.dialogStatus === "Abandoned") {
    return { action: "none" };
  }
  if (input.dialogStatus === "Review") return { action: "open" };

  if (
    input.hostSessionId &&
    input.liveHostSessionIds.has(input.hostSessionId)
  ) {
    return { action: "open" };
  }
  if (input.runStatus !== "Crashed" || input.dialogStatus !== "Crashed") {
    return input.runStatus === "NeedsInputIdle"
      ? { action: "refuse", status: input.runStatus, next: "respond" }
      : { action: "refuse", status: input.runStatus };
  }

  return { action: input.acpSessionId ? "recover" : "discard_only" };
}
