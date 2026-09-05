import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptAccepted, PromptResult } from "@/lib/supervisor-client";
import type { CommandReceipt } from "./contracts";
import type { CommandEnvelope, CommandKind } from "./types";

import { isDeepStrictEqual } from "node:util";

import pino, { type Logger } from "pino";

import {
  claimDelivering,
  failRetryable,
  getCommand,
  markAccepted,
  markFailed,
  markFenced,
  markSucceeded,
} from "./commands";
import { UNKNOWN_OUTCOME_DETAIL } from "./contracts";
import { commandSignals } from "./signals";

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
      ...(err.details?.reason !== undefined
        ? { reason: err.details.reason }
        : {}),
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
  let attempts = opts.command.attempts;

  for (;;) {
    const claimed = await claimDelivering(opts.db, commandId, attempts, {
      logger,
      now: now(),
    });

    if (!claimed.changed) {
      return { commandId };
    }
    attempts = claimed.row?.attempts ?? attempts + 1;

    try {
      const accepted = await opts.start(opts.envelope);

      if (accepted.commandId !== commandId || accepted.state !== "accepted") {
        throw new MaisterError(
          "ACP_PROTOCOL",
          "execution host returned a mismatched prompt admission",
          { details: { reason: "prompt_admission_mismatch", commandId } },
        );
      }
      await markAccepted(opts.db, commandId, attempts, { logger, now: now() });
      commandSignals.wake(commandId);
      logger.info(
        { commandId, commandKind: "session.prompt", attempt: attempts },
        "prompt-command-accepted",
      );

      return { commandId };
    } catch (error) {
      if (!isUnknownOutcome(error)) {
        const domainError = isMaisterError(error)
          ? error
          : new MaisterError("ACP_PROTOCOL", String(error));

        await (isFencedError(domainError) ? markFenced : markFailed)(
          opts.db,
          commandId,
          attempts,
          errorRecord(domainError),
          { logger, now: now() },
        );
        commandSignals.wake(commandId);
        throw domainError;
      }

      let receipt: CommandReceipt | null;

      try {
        receipt = await lookupReceiptUntilReachable(
          opts.lookupReceipt,
          commandId,
          sleep,
        );
      } catch (lookupError) {
        if (attempts >= policy.maxAttempts) {
          const unavailable = new MaisterError(
            "EXECUTOR_UNAVAILABLE",
            `prompt ${commandId} stayed unreachable while reconciling admission`,
            {
              cause: lookupError,
              details: { reason: "receipt_lookup_failed", commandId },
            },
          );

          await markFailed(
            opts.db,
            commandId,
            attempts,
            errorRecord(unavailable),
            {
              logger,
              now: now(),
            },
          );
          commandSignals.wake(commandId);
          throw unavailable;
        }
        await failRetryable(
          opts.db,
          commandId,
          attempts,
          errorRecord(lookupError),
          {
            nextAttemptAt: new Date(
              now().getTime() + backoffMs(policy.backoffBaseMs, attempts),
            ),
          },
          { logger, now: now() },
        );
        await sleep(backoffMs(policy.backoffBaseMs, attempts));
        continue;
      }
      if (receipt) {
        if (!receiptMatchesPromptCommand(opts.command, receipt)) {
          const mismatch = new MaisterError(
            "ACP_PROTOCOL",
            `prompt ${commandId} admission receipt identity does not match its durable command`,
            {
              details: {
                reason: "prompt_receipt_identity_mismatch",
                commandId,
              },
            },
          );

          await markFailed(
            opts.db,
            commandId,
            attempts,
            errorRecord(mismatch),
            { logger, now: now() },
          );
          commandSignals.wake(commandId);
          throw mismatch;
        }

        // A terminal receipt is reconciliation evidence, not a second
        // terminal writer. The canonical event projector alone settles the
        // command, including after an admission acknowledgement is lost.
        await markAccepted(opts.db, commandId, attempts, {
          logger,
          now: now(),
        });
        commandSignals.wake(commandId);

        return { commandId };
      }
      if (attempts >= policy.maxAttempts) {
        const exhausted = new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          `prompt ${commandId} exhausted its delivery budget`,
          { details: { reason: "delivery_budget_exhausted", commandId } },
        );

        await markFailed(opts.db, commandId, attempts, errorRecord(exhausted), {
          logger,
          now: now(),
        });
        commandSignals.wake(commandId);
        throw exhausted;
      }
      await failRetryable(
        opts.db,
        commandId,
        attempts,
        errorRecord(error),
        {
          nextAttemptAt: new Date(
            now().getTime() + backoffMs(policy.backoffBaseMs, attempts),
          ),
        },
        { logger, now: now() },
      );
      await sleep(backoffMs(policy.backoffBaseMs, attempts));
    }
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

function sameJson(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return isDeepStrictEqual(left, right);
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
      ...(reason ? { reason } : {}),
      commandId: row.id,
    },
  });
}

function receiptMatchesPromptCommand(
  row: ExecutionCommand,
  receipt: CommandReceipt,
): boolean {
  return (
    receipt.commandId === row.id &&
    receipt.runId === row.runId &&
    receipt.kind === row.kind &&
    receipt.assignmentEpoch === row.assignmentEpoch
  );
}

function promptTerminalConflict(
  row: ExecutionCommand,
  receipt: CommandReceipt,
  logger: Logger,
  checks: {
    identityAgrees: boolean;
    phaseAgrees: boolean;
    bodyAgrees: boolean;
  },
): MaisterError {
  logger.error(
    {
      commandId: row.id,
      eventState: row.state,
      receiptPhase: receipt.phase,
      receiptEventId: receipt.eventId,
      ...checks,
    },
    "prompt-terminal-conflict",
  );

  return new MaisterError(
    "CONFLICT",
    `prompt ${row.id} terminal event and receipt disagree`,
    {
      details: {
        reason: "prompt_terminal_conflict",
        commandId: row.id,
      },
    },
  );
}

function validateOpenPromptReceipt(input: {
  row: ExecutionCommand;
  receipt: CommandReceipt;
  logger: Logger;
}): void {
  const { row, receipt, logger } = input;

  if (receipt.phase === "accepted") return;

  const identityAgrees = receiptMatchesPromptCommand(row, receipt);

  if (!identityAgrees) {
    throw promptTerminalConflict(row, receipt, logger, {
      identityAgrees,
      phaseAgrees: true,
      bodyAgrees: true,
    });
  }

  if (receipt.phase === "completed") {
    if (typeof receipt.body.stopReason !== "string") {
      throw new MaisterError(
        "ACP_PROTOCOL",
        `prompt ${row.id} receipt has no valid terminal result`,
        { details: { reason: "prompt_result_invalid", commandId: row.id } },
      );
    }
  }
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

export async function waitForPromptCompletion(input: {
  db: Db;
  handle: PromptHandle;
  signal?: AbortSignal;
  assignmentIsCurrent?: () => Promise<boolean>;
  lookupReceipt?: (commandId: string) => Promise<CommandReceipt | null>;
  logger?: Logger;
}): Promise<PromptResult> {
  const logger = input.logger ?? defaultLog;

  for (;;) {
    const row = await getCommand(input.db, input.handle.commandId);

    if (!row || row.kind !== "session.prompt") {
      throw new MaisterError(
        "PRECONDITION",
        "prompt command is not available",
        {
          details: {
            reason: "prompt_command_missing",
            commandId: input.handle.commandId,
          },
        },
      );
    }
    if (row.state === "fenced") {
      throw promptFailureFromCommand(row);
    }
    let receipt: CommandReceipt | null = null;

    if (input.lookupReceipt) {
      try {
        receipt = await input.lookupReceipt(row.id);
      } catch (error) {
        logger.warn(
          {
            commandId: row.id,
            reason:
              error instanceof Error ? error.message : "receipt_lookup_failed",
          },
          "prompt-terminal-receipt-unavailable",
        );
      }
    }
    if (row.state === "succeeded" || row.state === "failed") {
      if (!input.lookupReceipt) {
        if (row.state === "succeeded") return promptResultFromCommand(row);

        throw promptFailureFromCommand(row);
      }

      if (!receipt || receipt.phase === "accepted") {
        if (
          receipt?.phase === "accepted" &&
          !receipt.inflight &&
          row.state === "failed" &&
          row.lastError?.reason === "turn_lost"
        ) {
          throw promptFailureFromCommand(row);
        }
        await waitForCommandWake(row.id, input.signal);
        continue;
      }

      const expectedPhase =
        row.state === "succeeded" ? "completed" : "rejected";
      const expectedBody =
        row.state === "succeeded" ? row.result : row.lastError;
      const identityAgrees = receiptMatchesPromptCommand(row, receipt);
      const phaseAgrees = receipt.phase === expectedPhase;
      const bodyAgrees = sameJson(receipt.body, expectedBody);
      const agrees = identityAgrees && phaseAgrees && bodyAgrees;

      if (!agrees) {
        throw promptTerminalConflict(row, receipt, logger, {
          identityAgrees,
          phaseAgrees,
          bodyAgrees,
        });
      }

      if (row.state === "succeeded") return promptResultFromCommand(row);

      throw promptFailureFromCommand(row);
    }
    if (receipt) validateOpenPromptReceipt({ row, receipt, logger });
    if (input.assignmentIsCurrent && !(await input.assignmentIsCurrent())) {
      // The host may have atomically committed the terminal receipt/event just
      // before checkpoint released this assignment. Keep the old driver
      // waiting for that durable outcome; locally fencing here would race the
      // legitimate terminal event and poison its projector.
      await waitForCommandWake(row.id, input.signal);

      continue;
    }
    await waitForCommandWake(row.id, input.signal);
  }
}
