import "server-only";

import type { ScratchDialogStatus } from "@/lib/db/schema";
import type { ScratchRunState } from "@/lib/scratch-runs/types";

import { MaisterError } from "@/lib/errors";

const terminalDialogStatuses = new Set<ScratchDialogStatus>([
  "Review",
  "Crashed",
  "Done",
  "Abandoned",
]);

const inputReadyDialogStatuses = new Set<ScratchDialogStatus>([
  "WaitingForUser",
]);

export function isTerminalScratchDialogStatus(
  status: ScratchDialogStatus,
): boolean {
  return terminalDialogStatuses.has(status);
}

export function assertScratchCanAcceptUserMessage(
  state: ScratchRunState,
): void {
  if (isTerminalScratchDialogStatus(state.dialogStatus)) {
    throw new MaisterError(
      "CONFLICT",
      `scratch run ${state.runId} is terminal (${state.dialogStatus}); cannot send message`,
    );
  }

  if (!inputReadyDialogStatuses.has(state.dialogStatus)) {
    throw new MaisterError(
      "CONFLICT",
      `scratch run ${state.runId} is ${state.dialogStatus}; user input is not accepted now`,
    );
  }

  if (!state.supervisorSessionId) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch run ${state.runId} has no live supervisor session`,
    );
  }
}

export function dialogStatusAfterSupervisorStop(args: {
  hasWorkspace: boolean;
}): ScratchDialogStatus {
  return args.hasWorkspace ? "Review" : "Abandoned";
}

export function dialogStatusAfterPromptCompletion(
  status: ScratchDialogStatus,
): ScratchDialogStatus {
  if (status === "Starting" || status === "Running") return "WaitingForUser";

  return status;
}

export function runStatusForDialogStatus(
  status: ScratchDialogStatus,
): "Running" | "NeedsInput" | "Review" | "Crashed" | "Done" | "Abandoned" {
  switch (status) {
    case "Starting":
    case "WaitingForUser":
    case "Running":
      return "Running";
    case "NeedsInput":
      return "NeedsInput";
    case "Review":
      return "Review";
    case "Crashed":
      return "Crashed";
    case "Done":
      return "Done";
    case "Abandoned":
      return "Abandoned";
  }
}
