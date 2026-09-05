import type { Logger } from "pino";
import type { ReceiptAdmission } from "./outbox-budget";
import type { CommandReceiptRow, HostState, ReceiptPhase } from "./host-state";
import type { CommandEnvelope, SupervisorErrorBody } from "./types";

import { createHash } from "node:crypto";

import { HostRuntimeEventError } from "./host-runtime-errors";
import {
  errorBody,
  httpStatusForCode,
  isSupervisorError,
  SupervisorError,
} from "./types";

// ADR-166 D6: a command id executes at most once per host. A duplicate with a
// completed/rejected receipt is replayed verbatim; a duplicate while the
// original is in flight joins it (any kind); an `accepted` receipt with no
// in-flight promise means the host restarted mid-turn (`turn_lost`).

export type CommandOutcome = {
  status: number;
  body: unknown;
};

export type ExecutedCommand = CommandOutcome & { replayed: boolean };

export type ReceiptTransition = {
  admission?: ReceiptAdmission;
  row: CommandReceiptRow;
  phase: ReceiptPhase;
  outcome: CommandOutcome;
};

type ExecuteCommandArgs = {
  envelope: CommandEnvelope;
  hostSessionId?: string;
  onAccepted?: () => void;
  persistReceipt?: (transition: ReceiptTransition) => void;
  afterReceipt?: (transition: ReceiptTransition) => void;
  admission?: ReceiptAdmission;
  run: () => Promise<CommandOutcome>;
};

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

  // ACP processes are intentionally not recovered across a supervisor restart.
  // Canonical receipts backed by producer wallets therefore become an
  // explicit terminal `turn_lost` pair before the host accepts new traffic.
  recoverAcceptedPrompts(): number {
    const recovered = this.state.recoverAcceptedPromptReceipts();

    if (recovered > 0) {
      this.logger.warn(
        { recovered },
        "accepted-producer-receipts-terminalized-after-restart",
      );
    }

    return recovered;
  }

  async execute(args: ExecuteCommandArgs): Promise<ExecutedCommand> {
    const { envelope } = args;
    const commandId = envelope.command.id;
    const existing = this.state.getReceipt(commandId);

    if (existing) {
      assertReceiptInvariant(existing, envelope);
    }

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

      this.writeReceipt(
        envelope,
        "rejected",
        rejected,
        existing.receivedAt,
        args,
      );
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

  // Upload bodies are replayable from byte zero. An accepted receipt with no
  // live request therefore represents a durable upload intent, not a lost ACP
  // turn. A concurrent duplicate is rejected immediately so its request body
  // is never mistaken for the original stream.
  async executeRestartableUpload(
    args: ExecuteCommandArgs,
  ): Promise<ExecutedCommand> {
    const { envelope } = args;
    const commandId = envelope.command.id;
    const existing = this.state.getReceipt(commandId);

    if (existing) assertReceiptInvariant(existing, envelope);
    if (existing && existing.phase !== "accepted") {
      return {
        status: existing.httpStatus,
        body: existing.body,
        replayed: true,
      };
    }
    if (this.inflight.has(commandId)) {
      const conflict = new SupervisorError(
        "PRECONDITION",
        "runtime object upload with this command id is already in progress",
        { details: { reason: "command_in_progress" } },
      );

      return {
        status: httpStatusForCode(conflict.code),
        body: errorBody(conflict),
        replayed: true,
      };
    }
    const receivedAt = existing?.receivedAt ?? this.now().toISOString();
    const promise = this.runFresh(args, receivedAt);

    this.inflight.set(commandId, promise);
    try {
      return { ...(await promise), replayed: false };
    } finally {
      this.inflight.delete(commandId);
    }
  }

  // The asynchronous prompt lifecycle commits acceptance before the ACP turn
  // starts, returns a stable 202 receipt, and settles the same receipt/event
  // pair when the background turn finishes. A lost HTTP acknowledgement is
  // therefore reconciled from GET /commands or the canonical event stream.
  async executeAsync(args: {
    envelope: CommandEnvelope;
    hostSessionId?: string;
    persistReceipt?: (transition: ReceiptTransition) => void;
    afterReceipt?: (transition: ReceiptTransition) => void;
    admission?: ReceiptAdmission;
    run: () => Promise<CommandOutcome>;
  }): Promise<ExecutedCommand> {
    const { envelope } = args;
    const commandId = envelope.command.id;
    const existing = this.state.getReceipt(commandId);

    if (existing) assertReceiptInvariant(existing, envelope);

    if (existing && existing.phase !== "accepted") {
      return {
        status: 202,
        body: { commandId, state: "accepted" },
        replayed: true,
      };
    }
    if (this.inflight.has(commandId)) {
      return {
        status: 202,
        body: { commandId, state: "accepted" },
        replayed: true,
      };
    }
    if (existing) {
      const turnLost = new SupervisorError(
        "PRECONDITION",
        "the turn for this command id was lost in a host restart",
        { details: { reason: "turn_lost", runId: envelope.fence.runId } },
      );
      const rejected = {
        status: httpStatusForCode(turnLost.code),
        body: errorBody(turnLost),
      } satisfies CommandOutcome;

      this.writeReceipt(
        envelope,
        "rejected",
        rejected,
        existing.receivedAt,
        args,
      );

      return { ...rejected, replayed: false };
    }

    const receivedAt = this.now().toISOString();
    const accepted = {
      status: 202,
      body: { commandId, state: "accepted" },
    } satisfies CommandOutcome;

    this.writeReceipt(envelope, "accepted", accepted, receivedAt, args);
    const completion = this.completeAsync(args, receivedAt);

    this.inflight.set(commandId, completion);
    void completion
      .catch((error) => {
        this.logger.error(
          {
            commandId,
            kind: envelope.command.kind,
            err: error instanceof Error ? error.message : String(error),
          },
          "async-command-completion-persist-failed",
        );
      })
      .finally(() => this.inflight.delete(commandId));

    return { ...accepted, replayed: false };
  }

  private async completeAsync(
    args: {
      envelope: CommandEnvelope;
      hostSessionId?: string;
      persistReceipt?: (transition: ReceiptTransition) => void;
      afterReceipt?: (transition: ReceiptTransition) => void;
      admission?: ReceiptAdmission;
      run: () => Promise<CommandOutcome>;
    },
    receivedAt: string,
  ): Promise<CommandOutcome> {
    let outcome: CommandOutcome;
    let phase: "completed" | "rejected" = "completed";

    try {
      outcome = await args.run();
    } catch (error) {
      const supervisorError = isSupervisorError(error)
        ? error
        : new SupervisorError(
            "ACP_PROTOCOL",
            error instanceof Error
              ? error.message
              : "asynchronous prompt failed",
            { cause: error },
          );

      outcome = {
        status: httpStatusForCode(supervisorError.code),
        body: errorBody(supervisorError),
      };
      phase = "rejected";
    }
    this.writeReceipt(args.envelope, phase, outcome, receivedAt, args);

    return outcome;
  }

  private async runFresh(
    args: ExecuteCommandArgs,
    receivedAt: string,
  ): Promise<CommandOutcome> {
    const { envelope } = args;

    this.writeReceipt(
      envelope,
      "accepted",
      { status: 202, body: {} },
      receivedAt,
      args,
    );
    args.onAccepted?.();

    let outcome: CommandOutcome;

    try {
      outcome = await args.run();
    } catch (err) {
      if (!isSupervisorError(err)) throw err;

      outcome = { status: httpStatusForCode(err.code), body: errorBody(err) };
      this.writeReceipt(envelope, "rejected", outcome, receivedAt, args);

      return outcome;
    }

    this.writeReceipt(envelope, "completed", outcome, receivedAt, args);

    return outcome;
  }

  private writeReceipt(
    envelope: CommandEnvelope,
    phase: "accepted" | "completed" | "rejected",
    outcome: CommandOutcome,
    receivedAt: string,
    callbacks: {
      envelope: CommandEnvelope;
      hostSessionId?: string;
      admission?: ReceiptAdmission;
      onAccepted?: () => void;
      persistReceipt?: (transition: ReceiptTransition) => void;
      afterReceipt?: (transition: ReceiptTransition) => void;
      run: () => Promise<CommandOutcome>;
    },
  ): void {
    const row: CommandReceiptRow = {
      commandId: envelope.command.id,
      runId: envelope.fence.runId,
      kind: envelope.command.kind,
      assignmentId: envelope.fence.assignmentId,
      epoch: envelope.fence.assignmentEpoch,
      hostSessionId: callbacks.hostSessionId ?? null,
      requestDigest: commandRequestDigest(envelope),
      eventId: null,
      phase,
      httpStatus: outcome.status,
      body: outcome.body ?? {},
      receivedAt,
      completedAt: phase === "accepted" ? null : this.now().toISOString(),
    };

    try {
      const transition = {
        row,
        phase,
        outcome,
        admission: callbacks.admission,
      } satisfies ReceiptTransition;

      if (callbacks.persistReceipt) {
        callbacks.persistReceipt(transition);
      } else {
        this.state.putReceipt(row, transition.admission);
      }
      callbacks.afterReceipt?.(transition);
    } catch (err) {
      if (err instanceof HostRuntimeEventError) throw err;
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
        `command receipt write failed for ${envelope.command.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
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
  eventId: string | null;
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
    eventId: row.eventId,
    receivedAt: row.receivedAt,
    completedAt: row.completedAt,
    inflight,
  };
}

// Command IDs are idempotency keys, not permission to substitute a different
// request. The digest is over a stable, unredacted representation and never
// leaves the host except through the manager command ledger's existing digest.
export function commandRequestDigest(envelope: CommandEnvelope): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        command: envelope.command,
        fence: envelope.fence,
        payload: envelope.payload,
      }),
    )
    .digest("hex");
}

function assertReceiptInvariant(
  existing: CommandReceiptRow,
  envelope: CommandEnvelope,
): void {
  const digest = commandRequestDigest(envelope);
  const mismatch =
    existing.runId !== envelope.fence.runId ||
    existing.kind !== envelope.command.kind ||
    existing.epoch !== envelope.fence.assignmentEpoch ||
    (existing.requestDigest !== null && existing.requestDigest !== digest);

  if (mismatch) {
    throw new SupervisorError(
      "PRECONDITION",
      `command id ${envelope.command.id} was already used for a different request`,
      { details: { reason: "command_invariant_conflict" } },
    );
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;

    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }

  throw new SupervisorError(
    "PRECONDITION",
    "command request contains a non-JSON value",
  );
}

export function isErrorBody(body: unknown): body is SupervisorErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string" &&
    typeof (body as { message?: unknown }).message === "string"
  );
}
