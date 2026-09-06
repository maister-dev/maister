import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptAccepted, PromptResult } from "@/lib/supervisor-client";
import type { CommandReceipt } from "./contracts";
import type { CommandEnvelope, CommandKind } from "./types";

import pino, { type Logger } from "pino";

import {
  claimDelivering,
  casTransition,
  recordUnknownPromptAdmission,
  failRetryable,
  getCommand,
  markAccepted,
  markFailed,
  markFenced,
  markSucceeded,
} from "./commands";
import { UNKNOWN_OUTCOME_DETAIL } from "./contracts";
import {
  COMMAND_REQUEST_SCHEMA,
  promptEnvelopeFromCommand,
} from "./command-request";
import {
  classifyPromptTransportFailure,
  isPromptProtocolConflict,
} from "./prompt-transport";
import { reconcilePromptCommand } from "./prompt-reconciliation";
import { commandSignals } from "./signals";
import {
  depositPromptReceipt,
  quarantinePromptProtocol,
  reconcileStoredPromptEvidence,
  promptEvidenceConflict,
} from "./prompt-evidence";

import { isMaisterError, MaisterError } from "@/lib/errors";

const defaultLog = pino({
  name: "execution-host",
  level: process.env.LOG_LEVEL ?? "info",
}).child({ component: "deliverer" });

// ADR-166 D5: per-kind delivery policy — a data table, never a switch (OCP).
// Budgets bound UNKNOWN-outcome retries of the SAME command id; a definitive
// error never retries. Prompt: 3 attempts before acceptance, 0 after.
export type KindPolicy = {
  maxAttempts: number;
  backoffBaseMs: number;
  driverless: boolean;
  timeoutMs: number | null;
};

export const COMMAND_POLICY: Readonly<Record<CommandKind, KindPolicy>> = {
  "workspace.adopt": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: false,
    timeoutMs: 10_000,
  },
  "workspace.release": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: true,
    timeoutMs: 10_000,
  },
  "session.create": {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    driverless: false,
    timeoutMs: 60_000,
  },
  "session.prompt": {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    driverless: false,
    timeoutMs: null,
  },
  "session.input": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: false,
    timeoutMs: 10_000,
  },
  "session.cancel": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: false,
    timeoutMs: 10_000,
  },
  "session.checkpoint": {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    driverless: false,
    timeoutMs: 30_000,
  },
  "session.delete": {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    driverless: true,
    timeoutMs: 30_000,
  },
  "runtime_object.reserve": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: false,
    timeoutMs: 10_000,
  },
  "runtime_object.upload": {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    driverless: false,
    timeoutMs: 60_000,
  },
  "runtime_object.delete": {
    maxAttempts: 3,
    backoffBaseMs: 500,
    driverless: true,
    timeoutMs: 30_000,
  },
};

export function isUnknownOutcome(err: unknown): boolean {
  return (
    isMaisterError(err) && err.details?.transport === UNKNOWN_OUTCOME_DETAIL
  );
}

export function isFencedError(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    err.code === "CONFLICT" &&
    err.details?.reason === "assignment_fenced"
  );
}

function errorRecord(err: unknown): Record<string, unknown> {
  if (isMaisterError(err)) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }

  return {
    code: "UNKNOWN",
    message: err instanceof Error ? err.message : String(err),
  };
}

function backoffMs(base: number, attempt: number): number {
  return base * 2 ** Math.max(0, attempt - 1);
}

// Bounded wait for a host that is restarting: 0.5 s · 2ⁿ over 5 attempts
// (≈ 15 s). `null` is the host's definitive 404; a throw is the transport.
export const RECEIPT_LOOKUP_ATTEMPTS = 5;
export const RECEIPT_LOOKUP_BACKOFF_MS = 500;

async function lookupReceiptUntilReachable(
  lookup: (commandId: string) => Promise<CommandReceipt | null>,
  commandId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<CommandReceipt | null> {
  let last: unknown;

  for (let attempt = 1; attempt <= RECEIPT_LOOKUP_ATTEMPTS; attempt += 1) {
    try {
      return await lookup(commandId);
    } catch (err) {
      last = err;
      if (classifyPromptTransportFailure(err).disposition !== "retry")
        throw err;
      if (attempt < RECEIPT_LOOKUP_ATTEMPTS) {
        await sleep(backoffMs(RECEIPT_LOOKUP_BACKOFF_MS, attempt));
      }
    }
  }

  throw last;
}

export type DeliverOptions<TResult> = {
  db: Db;
  command: ExecutionCommand;
  envelope: CommandEnvelope<unknown>;
  send: (envelope: CommandEnvelope<unknown>) => Promise<TResult>;
  // Result-derived domain writes commit in the SAME tx as the ack (E-EH-07).
  onAck?: (tx: Db, result: TResult) => Promise<void>;
  resultSummary?: (result: TResult) => Record<string, unknown> | null;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function summarize<T>(
  result: T,
  summary?: (result: T) => Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (summary) return summary(result);
  if (result && typeof result === "object")
    return result as Record<string, unknown>;

  return null;
}

// ADR-166 D4/D5 for IMMEDIATE kinds: claim → wire → ack. Unknown-outcome
// failures retry the same id up to the kind's budget with exponential
// backoff; FENCED is terminal (`fenced`); everything else is a definitive
// `failed`. The caller sees the transport's MaisterError unchanged.
export async function deliverCommand<TResult>(
  opts: DeliverOptions<TResult>,
): Promise<TResult> {
  const logger = opts.logger ?? defaultLog;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => new Date());
  const kind = opts.command.kind as CommandKind;
  const policy = COMMAND_POLICY[kind];
  let attempts = opts.command.attempts;

  for (;;) {
    const claimed = await claimDelivering(opts.db, opts.command.id, attempts, {
      logger,
      now: now(),
    });

    if (!claimed.changed) {
      throw new MaisterError(
        "CONFLICT",
        `command ${opts.command.id} is no longer claimable (state ${claimed.row?.state ?? "missing"})`,
        {
          details: {
            reason: "command_not_claimable",
            commandId: opts.command.id,
          },
        },
      );
    }

    attempts = claimed.row?.attempts ?? attempts + 1;
    const startedAt = Date.now();

    let result: TResult;

    try {
      result = await opts.send(opts.envelope);
    } catch (err) {
      const latencyMs = Date.now() - startedAt;

      if (isFencedError(err)) {
        await markFenced(opts.db, opts.command.id, attempts, errorRecord(err), {
          logger,
          now: now(),
        });
        logger.error(
          {
            commandId: opts.command.id,
            commandKind: kind,
            runId: opts.command.runId,
            assignmentEpoch: opts.command.assignmentEpoch,
            attempt: attempts,
            latencyMs,
            outcome: "fenced",
          },
          "command-fenced",
        );
        throw err;
      }

      if (isUnknownOutcome(err)) {
        const failed = await failRetryable(
          opts.db,
          opts.command.id,
          attempts,
          errorRecord(err),
          {
            nextAttemptAt: new Date(
              now().getTime() + backoffMs(policy.backoffBaseMs, attempts),
            ),
          },
          { logger, now: now() },
        );

        if (!failed.exhausted && policy.driverless) {
          // A driverless kind (`session.delete`, `workspace.release`) needs no
          // waiting driver: after one unknown outcome the row stays `queued`
          // for the recovery pass to re-deliver (ADR-166 D5 W1) instead of
          // holding the caller through the retry budget.
          logger.warn(
            {
              commandId: opts.command.id,
              commandKind: kind,
              attempt: attempts,
              latencyMs,
              outcome: "deferred",
            },
            "command-deferred-to-recovery",
          );
          throw new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            `command ${kind} ${opts.command.id} deferred to recovery: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err, details: { reason: "delivery_deferred" } },
          );
        }

        if (!failed.exhausted) {
          logger.warn(
            {
              commandId: opts.command.id,
              commandKind: kind,
              attempt: attempts,
              maxAttempts: opts.command.maxAttempts,
              latencyMs,
              outcome: "retry",
            },
            "command-retry",
          );
          await sleep(backoffMs(policy.backoffBaseMs, attempts));
          continue;
        }

        logger.error(
          {
            commandId: opts.command.id,
            commandKind: kind,
            attempt: attempts,
            latencyMs,
            outcome: "failed",
          },
          "command-failed-budget-exhausted",
        );
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          `command ${kind} ${opts.command.id} exhausted its delivery budget: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err, details: { reason: "delivery_budget_exhausted" } },
        );
      }

      await markFailed(opts.db, opts.command.id, attempts, errorRecord(err), {
        logger,
        now: now(),
      });
      logger.warn(
        {
          commandId: opts.command.id,
          commandKind: kind,
          attempt: attempts,
          latencyMs,
          outcome: "failed",
          code: isMaisterError(err) ? err.code : "UNKNOWN",
        },
        "command-failed",
      );
      throw err;
    }

    const latencyMs = Date.now() - startedAt;

    await opts.db.transaction(async (tx) => {
      await markSucceeded(
        tx as unknown as Db,
        opts.command.id,
        attempts,
        summarize(result, opts.resultSummary),
        { logger, now: now() },
      );
      await opts.onAck?.(tx as unknown as Db, result);
    });

    logger.info(
      {
        commandId: opts.command.id,
        commandKind: kind,
        runId: opts.command.runId,
        assignmentEpoch: opts.command.assignmentEpoch,
        attempt: attempts,
        latencyMs,
        outcome: "succeeded",
      },
      "command-succeeded",
    );

    return result;
  }
}

export type PromptHandle = {
  commandId: string;
};

export type StartAsyncPromptOptions = {
  db: Db;
  command: ExecutionCommand;
  envelope: CommandEnvelope<unknown>;
  start: (envelope: CommandEnvelope<unknown>) => Promise<PromptAccepted>;
  lookupReceipt: (commandId: string) => Promise<CommandReceipt | null>;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

// Canonical mode never waits for an ACP response. The accepted command/receipt
// is the admission result; terminal state arrives through a committed canonical
// event and is reconciled against the same host receipt after acknowledgement
// loss. The command id remains unchanged across every retry.
export async function startAsyncPrompt(
  opts: StartAsyncPromptOptions,
): Promise<PromptHandle> {
  const logger = opts.logger ?? defaultLog;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => new Date());
  const commandId = opts.command.id;
  const policy = COMMAND_POLICY["session.prompt"];
  let current = await getCommand(opts.db, commandId);

  for (;;) {
    if (!current || current.kind !== "session.prompt")
      throw new MaisterError(
        "PRECONDITION",
        "prompt command is not available",
        {
          details: { reason: "prompt_command_missing", commandId },
        },
      );
    if (current.applicationError?.reason === "prompt_terminal_conflict")
      throw promptEvidenceConflict(commandId);
    if (
      current.state !== "queued" ||
      current.transportState === "acknowledged" ||
      current.transportState === "reconciliation_required" ||
      current.attempts >= current.maxAttempts
    )
      return { commandId };
    // Reparse the frozen request on every dispatch; caller payload is never a
    // replay source for v2 commands, including a retry after process restart.
    const envelope =
      current.requestSchema === COMMAND_REQUEST_SCHEMA
        ? promptEnvelopeFromCommand(current, opts.envelope.fence.hostKey)
        : opts.envelope;
    const claimed = await casTransition(
      opts.db,
      commandId,
      ["queued"],
      current.attempts,
      {
        state: "delivering",
        attempts: current.attempts + 1,
        deliveringSince: now(),
        nextAttemptAt: null,
        transportState: "dispatching",
      },
      { logger, now: now() },
    );

    if (!claimed.changed || !claimed.row) return { commandId };
    const attempts = claimed.row.attempts;
    let failure: ReturnType<typeof classifyPromptTransportFailure>;

    try {
      const accepted = await opts.start(envelope);

      if (accepted.commandId !== commandId || accepted.state !== "accepted")
        throw new MaisterError(
          "ACP_PROTOCOL",
          "execution host returned a mismatched prompt admission",
          {
            details: { reason: "prompt_admission_mismatch", commandId },
          },
        );
    } catch (error) {
      failure = classifyPromptTransportFailure(error);
      // A later preflight refusal says nothing about an earlier unknown send.
      if (
        failure.disposition === "not_sent" &&
        current.attempts === 0 &&
        current.transportState === "not_sent"
      ) {
        await markFailed(
          opts.db,
          commandId,
          attempts,
          {
            code: "PRECONDITION",
            message: "prompt request was refused before dispatch",
            details: {
              transport: "not_sent",
              reason: "transport_request_invalid",
            },
          },
          { logger, now: now() },
        );
        commandSignals.wake(commandId);
        throw error;
      }
      let receipt: CommandReceipt | null = null;

      try {
        receipt = await lookupReceiptUntilReachable(
          opts.lookupReceipt,
          commandId,
          sleep,
        );
      } catch (lookupError) {
        const cause = classifyPromptTransportFailure(lookupError);

        if (isPromptProtocolConflict(lookupError)) {
          await quarantinePromptProtocol(opts.db, commandId, "receipt");
          throw promptEvidenceConflict(commandId);
        }
        if (cause.disposition !== "retry") failure = cause;
        logger.warn(
          { commandId, attempt: attempts, ...cause },
          "prompt-admission-receipt-unavailable",
        );
      }
      if (receipt) {
        const evidence = await depositPromptReceipt(
          opts.db,
          commandId,
          receipt,
        );

        if (evidence.disposition === "quarantined")
          throw promptEvidenceConflict(commandId);
        await markAccepted(opts.db, commandId, attempts, {
          logger,
          now: now(),
        });
        await reconcileStoredPromptEvidence(
          opts.db,
          commandId,
          AbortSignal.timeout(30_000),
        );

        return { commandId };
      }
      if (isPromptProtocolConflict(error)) {
        await quarantinePromptProtocol(opts.db, commandId, "admission");
        throw promptEvidenceConflict(commandId);
      }
      const exhausted =
        attempts >= current.maxAttempts || failure.disposition !== "retry";
      const delayMs = exhausted
        ? 5_000
        : backoffMs(policy.backoffBaseMs, attempts);
      const transition = await recordUnknownPromptAdmission(
        opts.db,
        commandId,
        attempts,
        new Date(now().getTime() + delayMs),
        exhausted ? "reconciliation_required" : "unknown",
        { logger, now: now() },
      );

      commandSignals.wake(commandId);
      logger.warn(
        {
          commandId,
          attempt: attempts,
          ...failure,
          exhausted,
          nextAttemptAt: transition.row?.nextAttemptAt,
          transportState: transition.row?.transportState,
        },
        "prompt-admission-unknown",
      );
      if (
        exhausted ||
        !transition.changed ||
        transition.row?.state !== "queued"
      )
        return { commandId };
      await sleep(delayMs);
      current = await getCommand(opts.db, commandId);
      continue;
    }
    // DB failure after a valid ACK must escape as storage failure, never be
    // classified as a remote refusal or overwrite an already accepted command.
    await markAccepted(opts.db, commandId, attempts, { logger, now: now() });
    commandSignals.wake(commandId);
    logger.info(
      { commandId, commandKind: "session.prompt", attempt: attempts },
      "prompt-command-accepted",
    );

    return { commandId };
  }
}

function promptResultFromCommand(row: ExecutionCommand): PromptResult {
  const result = row.result;

  if (!result || typeof result.stopReason !== "string") {
    throw new MaisterError(
      "ACP_PROTOCOL",
      `prompt ${row.id} succeeded without a valid terminal result`,
      { details: { reason: "prompt_result_invalid", commandId: row.id } },
    );
  }

  return result as PromptResult;
}

function promptFailureFromCommand(row: ExecutionCommand): MaisterError {
  const error = row.lastError ?? {};
  const nestedDetails =
    error.details &&
    typeof error.details === "object" &&
    !Array.isArray(error.details)
      ? (error.details as Record<string, unknown>)
      : null;
  const reason =
    typeof error.reason === "string"
      ? error.reason
      : typeof nestedDetails?.reason === "string"
        ? nestedDetails.reason
        : undefined;
  const fenced =
    error.code === "FENCED" ||
    (error.code === "CONFLICT" && reason === "assignment_fenced");
  const code = fenced ? "CONFLICT" : "ACP_PROTOCOL";
  const message =
    typeof error.message === "string"
      ? error.message
      : `prompt ${row.id} ${row.state}`;

  return new MaisterError(code, message, {
    details: {
      ...nestedDetails,
      ...(reason ? { reason } : {}),
      commandId: row.id,
    },
  });
}

async function waitForCommandWake(
  commandId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new MaisterError("PRECONDITION", "prompt completion wait aborted", {
      details: { reason: "prompt_wait_aborted", commandId },
    });
  }

  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      reject(
        new MaisterError("PRECONDITION", "prompt completion wait aborted", {
          details: { reason: "prompt_wait_aborted", commandId },
        }),
      );
    };
    const unsubscribe = commandSignals.subscribe(commandId, finish);
    const timeout = setTimeout(finish, 250);

    signal?.addEventListener("abort", abort, { once: true });
  });
}

export type PromptQueryOptions = {
  db: Db;
  handle: PromptHandle;
  signal?: AbortSignal;
  lookupReceipt?: (commandId: string) => Promise<CommandReceipt | null>;
  now?: () => Date;
  logger?: Logger;
};

export type PromptQueryResult =
  | { commandId: string; state: "succeeded"; result: PromptResult }
  | {
      commandId: string;
      state: "pending";
      transportState: ExecutionCommand["transportState"];
      nextReconcileAt: string | null;
    };

/** Bounded query over the same evidence path as waits and startup recovery.
 * Private request/owner fields never leave this query result.
 */
export async function queryPrompt(
  input: PromptQueryOptions,
): Promise<PromptQueryResult> {
  const evidence = await reconcilePromptCommand({
    db: input.db,
    commandId: input.handle.commandId,
    signal: input.signal,
    lookupReceipt: input.lookupReceipt,
    logger: input.logger,
    now: input.now,
  });

  if (evidence.disposition === "quarantined")
    throw promptEvidenceConflict(input.handle.commandId);
  if (evidence.disposition === "settled") {
    if (evidence.command.state === "succeeded")
      return {
        commandId: input.handle.commandId,
        state: "succeeded",
        result: promptResultFromCommand(evidence.command),
      };
    throw promptFailureFromCommand(evidence.command);
  }

  return {
    commandId: input.handle.commandId,
    state: "pending",
    transportState: evidence.command.transportState,
    nextReconcileAt: evidence.command.nextAttemptAt?.toISOString() ?? null,
  };
}

export async function waitForPromptCompletion(
  input: PromptQueryOptions & {
    assignmentIsCurrent?: () => Promise<boolean>;
  },
): Promise<PromptResult> {
  for (;;) {
    const result = await queryPrompt(input);

    if (result.state === "succeeded") return result.result;
    await waitForCommandWake(input.handle.commandId, input.signal);
  }
}
