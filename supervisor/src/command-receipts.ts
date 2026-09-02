import type { Logger } from "pino";
import type { CommandReceiptRow, HostState } from "./host-state";
import type { CommandEnvelope, SupervisorErrorBody } from "./types";

import {
  errorBody,
  httpStatusForCode,
  isSupervisorError,
  SupervisorError,
} from "./types";

// ADR-164 D6: a command id executes at most once per host. A duplicate with a
// completed/rejected receipt is replayed verbatim; a duplicate while the
// original is in flight joins it (any kind); an `accepted` receipt with no
// in-flight promise means the host restarted mid-turn (`turn_lost`).

export type CommandOutcome = {
  status: number;
  body: unknown;
};

export type ExecutedCommand = CommandOutcome & { replayed: boolean };

export const REPLAYED_HEADER = "x-maister-command-replayed";

export class CommandReceipts {
  private readonly inflight = new Map<string, Promise<CommandOutcome>>();
  private readonly logger: Logger;

  constructor(
    private readonly state: HostState,
    logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.logger = logger.child({ component: "command-receipts" });
  }

  lookup(commandId: string): CommandReceiptRow | null {
    return this.state.getReceipt(commandId);
  }

  hasInflight(commandId: string): boolean {
    return this.inflight.has(commandId);
  }

  async execute(args: {
    envelope: CommandEnvelope;
    // Called once the `accepted` receipt is durable and BEFORE the effect runs.
    onAccepted?: () => void;
    run: () => Promise<CommandOutcome>;
  }): Promise<ExecutedCommand> {
    const { envelope } = args;
    const commandId = envelope.command.id;
    const existing = this.state.getReceipt(commandId);

    if (existing && existing.phase !== "accepted") {
      this.logger.info(
        { commandId, kind: envelope.command.kind, phase: existing.phase },
        "command-replayed",
      );

      return {
        status: existing.httpStatus,
        body: existing.body,
        replayed: true,
      };
    }

    const joined = this.inflight.get(commandId);

    if (joined) {
      this.logger.info(
        { commandId, kind: envelope.command.kind },
        "command-joined-inflight",
      );

      return { ...(await joined), replayed: true };
    }

    if (existing) {
      const turnLost = new SupervisorError(
        "PRECONDITION",
        "the turn for this command id was lost in a host restart",
        { details: { reason: "turn_lost", runId: envelope.fence.runId } },
      );
      const rejected: CommandOutcome = {
        status: httpStatusForCode(turnLost.code),
        body: errorBody(turnLost),
      };

      this.writeReceipt(envelope, "rejected", rejected, existing.receivedAt);
      this.logger.warn(
        { commandId, kind: envelope.command.kind },
        "command-turn-lost",
      );

      return { ...rejected, replayed: false };
    }

    const receivedAt = this.now().toISOString();
    const promise = this.runFresh(args, receivedAt);

    this.inflight.set(commandId, promise);

    try {
      return { ...(await promise), replayed: false };
    } finally {
      this.inflight.delete(commandId);
    }
  }

  private async runFresh(
    args: {
      envelope: CommandEnvelope;
      onAccepted?: () => void;
      run: () => Promise<CommandOutcome>;
    },
    receivedAt: string,
  ): Promise<CommandOutcome> {
    const { envelope } = args;

    this.writeReceipt(
      envelope,
      "accepted",
      { status: 202, body: {} },
      receivedAt,
    );
    args.onAccepted?.();

    let outcome: CommandOutcome;

    try {
      outcome = await args.run();
    } catch (err) {
      if (!isSupervisorError(err)) throw err;

      outcome = { status: httpStatusForCode(err.code), body: errorBody(err) };
      this.writeReceipt(envelope, "rejected", outcome, receivedAt);

      return outcome;
    }

    this.writeReceipt(envelope, "completed", outcome, receivedAt);

    return outcome;
  }

  private writeReceipt(
    envelope: CommandEnvelope,
    phase: "accepted" | "completed" | "rejected",
    outcome: CommandOutcome,
    receivedAt: string,
  ): void {
    try {
      this.state.putReceipt({
        commandId: envelope.command.id,
        runId: envelope.fence.runId,
        kind: envelope.command.kind,
        epoch: envelope.fence.assignmentEpoch,
        phase,
        httpStatus: outcome.status,
        body: outcome.body ?? {},
        receivedAt,
        completedAt: phase === "accepted" ? null : this.now().toISOString(),
      });
    } catch (err) {
      this.logger.error(
        {
          commandId: envelope.command.id,
          phase,
          err: err instanceof Error ? err.message : String(err),
        },
        "command-receipt-write-failed",
      );
      throw new SupervisorError(
        "ACP_PROTOCOL",
        `command receipt write failed for ${envelope.command.id}`,
        { cause: err },
      );
    }

    this.logger.debug(
      {
        commandId: envelope.command.id,
        kind: envelope.command.kind,
        phase,
        httpStatus: outcome.status,
      },
      "command-receipt",
    );
  }
}

// `inflight` is process memory next to the durable row: an `accepted` receipt
// with `inflight:false` is the restart-mid-turn signature the web folds as
// `turn_lost` without re-sending the command.
export function receiptToResponse(
  row: CommandReceiptRow,
  inflight: boolean,
): {
  commandId: string;
  runId: string;
  kind: string;
  assignmentEpoch: number;
  phase: CommandReceiptRow["phase"];
  httpStatus: number;
  body: Record<string, unknown>;
  receivedAt: string;
  completedAt: string | null;
  inflight: boolean;
} {
  return {
    commandId: row.commandId,
    runId: row.runId,
    kind: row.kind,
    assignmentEpoch: row.epoch,
    phase: row.phase,
    httpStatus: row.httpStatus,
    body:
      row.body && typeof row.body === "object"
        ? (row.body as Record<string, unknown>)
        : {},
    receivedAt: row.receivedAt,
    completedAt: row.completedAt,
    inflight,
  };
}

export function isErrorBody(body: unknown): body is SupervisorErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string" &&
    typeof (body as { message?: unknown }).message === "string"
  );
}
