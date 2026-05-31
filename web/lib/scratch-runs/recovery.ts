import "server-only";

import type { ScratchDialogStatus } from "@/lib/db/schema";
import type { SupervisorSessionRecord } from "@/lib/supervisor-client";

export type ScratchRecoveryAction =
  | "open"
  | "recover"
  | "discard_only"
  | "none";

export type ScratchRecoveryInput = {
  runStatus: string;
  dialogStatus: ScratchDialogStatus;
  acpSessionId: string | null;
  supervisorSessionId: string | null;
  workspaceRemoved: boolean;
  liveSupervisorSessionIds: ReadonlySet<string>;
};

export function liveScratchSupervisorSessionIds(
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
): ScratchRecoveryAction {
  if (input.workspaceRemoved) return "none";
  if (input.dialogStatus === "Done" || input.dialogStatus === "Abandoned") {
    return "none";
  }
  if (input.dialogStatus === "Review") return "open";

  if (
    input.supervisorSessionId &&
    input.liveSupervisorSessionIds.has(input.supervisorSessionId)
  ) {
    return "open";
  }

  return input.acpSessionId ? "recover" : "discard_only";
}
