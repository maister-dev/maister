import type { Logger } from "pino";
import type { ReceiptAdmission } from "./outbox-budget";
import type {
  CommandReceiptRow,
  CommandRetirementProof,
  HostState,
  ReceiptPhase,
  ReceiptRetirementOutcome,
} from "./host-state";
import type { CommandEnvelope, SupervisorErrorBody } from "./types";

import { createHash } from "node:crypto";

import {
  parseCommandReceiptV2,
  type CommandReceiptV2,
  type ImmutableObjectReference,
} from "../../runtime/command-evidence";
import {
  canonicalCommandJson,
  CommandJsonError,
} from "../../runtime/command-json";

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
  responseReference?: ImmutableObjectReference;
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

// D5: reserve and delete are idempotent over the durable object row, so an
// accepted receipt with no live request is an interrupted effect to re-run
// against that row, never a lost ACP turn.
const RESTARTABLE_OBJECT_KINDS = new Set<string>([
  "runtime_object.reserve",
  "runtime_object.delete",
]);

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

  // D6: eligibility is re-derived from this host's own receipt. The manager's
  // proof is compared, never trusted.
  retire(
    commandId: string,
    proof: CommandRetirementProof,
  ): ReceiptRetirementOutcome {
    const outcome = this.state.retireReceipt(commandId, proof);

    this.logger.info(
      { commandId, outcome: outcome.outcome, phase: proof.expectedPhase },
      "command-retirement",
    );

    return outcome;
  }

  async execute(args: ExecuteCommandArgs): Promise<ExecutedCommand> {
    const { envelope } = args;
    const commandId = envelope.command.id;

    assertRequestTarget(envelope, args.hostSessionId);
    const existing = this.state.getReceipt(commandId);

    if (existing) {
      assertReceiptInvariant(existing, envelope, args.hostSessionId);
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

    if (existing && RESTARTABLE_OBJECT_KINDS.has(envelope.command.kind)) {
      const promise = this.runFresh(args, existing.receivedAt);

      this.inflight.set(commandId, promise);
      try {
        return { ...(await promise), replayed: false };
      } finally {
        this.inflight.delete(commandId);
      }
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

    assertRequestTarget(envelope, args.hostSessionId);
    const existing = this.state.getReceipt(commandId);

    if (existing)
      assertReceiptInvariant(existing, envelope, args.hostSessionId);
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

    assertRequestTarget(envelope, args.hostSessionId);
    const existing = this.state.getReceipt(commandId);

    if (existing)
      assertReceiptInvariant(existing, envelope, args.hostSessionId);

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
        this.state.reportRuntimeStorageFailure(error);
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
      this.state.reportRuntimeStorageFailure(error);
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
      this.state.reportRuntimeStorageFailure(err);
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
    const prior = this.state.getReceipt(envelope.command.id);
    const row: CommandReceiptRow = {
      commandId: envelope.command.id,
      runId: envelope.fence.runId,
      kind: envelope.command.kind,
      assignmentId: envelope.fence.assignmentId,
      epoch: envelope.fence.assignmentEpoch,
      hostSessionId: callbacks.hostSessionId ?? null,
      requestVersion: prior?.requestVersion ?? envelope.requestVersion ?? 1,
      requestSchema: prior
        ? (prior.requestSchema ?? null)
        : "maister.command.request.v2",
      hostKey: prior ? (prior.hostKey ?? null) : this.state.hostKey,
      requestDigest: prior
        ? prior.requestDigest
        : commandRequestDigest(envelope, callbacks.hostSessionId ?? null),
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

type LegacyCommandReceipt = {
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
};

/** V2 evidence is formatted only from durable native fields. Legacy rows keep
 * their original wire protocol until their owners are explicitly migrated.
 */
export function receiptToResponse(
  row: CommandReceiptRow,
  inflight: boolean,
): LegacyCommandReceipt | CommandReceiptV2 {
  if (row.requestVersion === 2) {
    const failed = row.phase === "rejected";
    const error = failed && isErrorBody(row.body) ? row.body : null;

    return parseCommandReceiptV2({
      receiptVersion: 2,
      commandId: row.commandId,
      kind: row.kind,
      hostKey: row.hostKey,
      runId: row.runId,
      assignmentId: row.assignmentId,
      assignmentEpoch: row.epoch,
      hostSessionId: row.hostSessionId,
      requestSchema: row.requestSchema,
      requestSha256: row.requestDigest,
      phase: row.phase,
      httpStatus: row.httpStatus,
      receivedAt: row.receivedAt,
      terminal:
        row.phase === "accepted"
          ? null
          : {
              outcomeVersion: 2,
              status: failed
                ? error?.code === "FENCED"
                  ? "fenced"
                  : "failed"
                : "succeeded",
              eventId: row.eventId,
              streamId: row.terminalStreamId,
              sequence: row.terminalSequence,
              result: failed ? null : row.body,
              error,
            },
    });
  }

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

function assertRequestTarget(
  envelope: CommandEnvelope,
  hostSessionId: string | undefined,
): void {
  if (
    envelope.requestVersion === 2 &&
    (envelope.command.kind !== "session.prompt" ||
      !hostSessionId ||
      envelope.target?.hostSessionId !== hostSessionId)
  ) {
    throw new SupervisorError(
      "PRECONDITION",
      "command target does not match its route",
      {
        details: { reason: "command_invariant_conflict" },
      },
    );
  }
}

// Command IDs are idempotency keys, not permission to substitute a different
// request. The digest is over a stable, unredacted representation and never
// leaves the host except through the manager command ledger's existing digest.
export function commandRequestDigest(
  envelope: CommandEnvelope,
  hostSessionId: string | null,
): string {
  return requestDigest({
    requestVersion: 2,
    command: envelope.command,
    fence: envelope.fence,
    target: { hostSessionId },
    payload: envelope.payload,
  });
}

function requestDigest(value: unknown): string {
  try {
    return createHash("sha256")
      .update(canonicalCommandJson(value), "utf8")
      .digest("hex");
  } catch (error) {
    if (error instanceof CommandJsonError)
      throw new SupervisorError(
        "PRECONDITION",
        "command request is not valid canonical JSON",
        { details: { reason: "command_invariant_conflict" } },
      );
    throw error;
  }
}

function assertReceiptInvariant(
  existing: CommandReceiptRow,
  envelope: CommandEnvelope,
  hostSessionId: string | undefined,
): void {
  const digest =
    existing.requestSchema === "maister.command.request.v2"
      ? commandRequestDigest(envelope, hostSessionId ?? null)
      : requestDigest({
          command: envelope.command,
          fence: envelope.fence,
          payload: envelope.payload,
        });
  const mismatch =
    (existing.requestVersion ?? 1) !== (envelope.requestVersion ?? 1) ||
    existing.runId !== envelope.fence.runId ||
    existing.kind !== envelope.command.kind ||
    existing.epoch !== envelope.fence.assignmentEpoch ||
    (existing.hostKey != null && existing.hostKey !== envelope.fence.hostKey) ||
    (existing.assignmentId !== null &&
      existing.assignmentId !== envelope.fence.assignmentId) ||
    existing.hostSessionId !== (hostSessionId ?? null) ||
    (existing.requestDigest !== null && existing.requestDigest !== digest);

  if (mismatch) {
    throw new SupervisorError(
      "PRECONDITION",
      `command id ${envelope.command.id} was already used for a different request`,
      { details: { reason: "command_invariant_conflict" } },
    );
  }
}

export function isErrorBody(body: unknown): body is SupervisorErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { code?: unknown }).code === "string" &&
    typeof (body as { message?: unknown }).message === "string"
  );
}
