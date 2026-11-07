import type { Logger } from "pino";
import type { CommandReceiptRow, HostState } from "./host-state";
import type { RegistryEntry } from "./registry";
import type { SessionCreateFailure } from "../../runtime/session-create-failure";

import { safeErrorCauseChain } from "../../runtime/safe-error-cause";

import { ownedSessionProcessGroupRetired } from "./execution-fence";
import { errorBody, isSupervisorError, SupervisorError } from "./types";

/** A failed handshake whose process lifetime is still unknown keeps its create receipt unresolved. */
export class UnsettledSessionCreateError extends SupervisorError {
  readonly retainedSession: RegistryEntry | null;

  constructor(
    input: Readonly<{
      runId: string;
      sessionId: string;
      stage: "process_exit" | "terminal_output";
      killGraceMs: number;
      cause: unknown;
      retainedSession: RegistryEntry | null;
    }>,
  ) {
    super(
      "EXECUTOR_UNAVAILABLE",
      "Session creation failed but teardown is unconfirmed; reconcile the retained host session before releasing its workspace",
      {
        cause: input.cause,
        details: {
          reason: "session_create_exit_unconfirmed",
          runId: input.runId,
          sessionId: input.sessionId,
          stage: input.stage,
          killGraceMs: input.killGraceMs,
          sessionCreateFailure: (isSupervisorError(input.cause)
            ? input.cause.details?.sessionCreateFailure
            : undefined) ?? {
            version: 1,
            stage: "acp_handshake",
            causeChain: safeErrorCauseChain(input.cause),
          },
        },
      },
    );
    this.name = "UnsettledSessionCreateError";
    this.retainedSession = input.retainedSession;
    Object.setPrototypeOf(this, UnsettledSessionCreateError.prototype);
  }
}

/** Minted only before native spawn or by its error event when no child PID exists. */
export class UnstartedSessionProcessError extends SupervisorError {
  constructor(cause: unknown) {
    super(
      isSupervisorError(cause) ? cause.code : "SPAWN",
      "Session preparation failed before an adapter process was created; verify its configuration and filesystem access",
      {
        cause,
        details: {
          ...(isSupervisorError(cause) ? cause.details : {}),
          sessionCreateQuiescence: { version: 1, process: "not_started" },
          sessionCreateFailure: {
            version: 1,
            stage: "spawn",
            causeChain: safeErrorCauseChain(cause),
          },
        },
      },
    );
    this.name = "UnstartedSessionProcessError";
    Object.setPrototypeOf(this, UnstartedSessionProcessError.prototype);
  }
}

/** Only the host's explicit unresolved create outcome is replayable without re-executing spawn. */
export function isUnsettledSessionCreateReceipt(
  receipt: CommandReceiptRow,
): boolean {
  if (receipt.kind !== "session.create" || receipt.phase !== "accepted")
    return false;
  const body = receipt.body as { details?: { reason?: unknown } };

  return body?.details?.reason === "session_create_exit_unconfirmed";
}

/** Confirmed retirement closes the same durable create; terminal historical receipts are never rewritten. */
export async function settleRetiredSessionCreate(
  input: Readonly<{
    entry: RegistryEntry;
    state: HostState;
    logger: Logger;
  }>,
): Promise<void> {
  const { entry, state, logger } = input;
  const { record, child } = entry;

  if (
    (child.exitCode === null && child.signalCode === null) ||
    !record.terminalPublished
  )
    return;
  const receipt = state.getReceipt(record.createdByCommandId);

  if (
    !receipt ||
    !isUnsettledSessionCreateReceipt(receipt) ||
    receipt.runId !== record.runId ||
    receipt.assignmentId !== record.assignmentId ||
    receipt.epoch !== record.assignmentEpoch ||
    receipt.hostKey !== state.hostKey
  )
    return;
  const details = (
    receipt.body as {
      details: {
        sessionId?: unknown;
        sessionCreateFailure?: SessionCreateFailure;
      };
    }
  ).details;

  if (details.sessionId !== record.sessionId) return;
  if (record.processGroup) {
    if (!(await ownedSessionProcessGroupRetired(entry))) return;
    const obligation = state
      .sessionProcessesForRun(record.runId)
      .find((candidate) => candidate.commandId === record.createdByCommandId);

    if (obligation?.phase === "registered")
      state.releaseSessionProcess(
        obligation.commandId,
        new Date().toISOString(),
      );
  }
  state.putReceipt({
    ...receipt,
    phase: "rejected",
    httpStatus: 503,
    completedAt: new Date().toISOString(),
    body: errorBody(
      new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "Session creation failed; its original process exit and terminal output are now confirmed",
        {
          details: {
            runId: record.runId,
            sessionId: record.sessionId,
            ...(details.sessionCreateFailure
              ? { sessionCreateFailure: details.sessionCreateFailure }
              : {}),
            sessionCreateQuiescence: { version: 1, process: "terminated" },
          },
        },
      ),
    ),
  });
  logger.info(
    {
      commandId: receipt.commandId,
      sessionId: record.sessionId,
      runId: record.runId,
    },
    "session-create-retirement-confirmed",
  );
}

/** The retained process owns this one-shot observer; no retry, timer, or new command is created. */
export function observeUnsettledSessionCreate(
  input: Readonly<{
    error: UnsettledSessionCreateError;
    state: HostState;
    logger: Logger;
  }>,
): void {
  const entry = input.error.retainedSession;

  if (!entry) return;
  const settle = (): void => {
    const terminal = entry.record.outputTerminal;

    if (!terminal) return;
    void terminal
      .then(() =>
        settleRetiredSessionCreate({
          state: input.state,
          logger: input.logger,
          entry,
        }),
      )
      .catch((error: unknown) => {
        input.logger.error(
          {
            commandId: entry.record.createdByCommandId,
            sessionId: entry.record.sessionId,
            error: error instanceof Error ? error.name : typeof error,
          },
          "session-create-retirement-unconfirmed",
        );
      });
  };

  if (entry.child.exitCode !== null || entry.child.signalCode !== null)
    settle();
  else entry.child.once("exit", settle);
}
