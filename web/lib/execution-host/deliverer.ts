import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptAccepted, PromptResult } from "@/lib/supervisor-client";
import type { CommandReceipt } from "./contracts";
import type { CommandEnvelope, CommandKind } from "./types";

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

export type DeliverPromptOptions = {
  db: Db;
  command: ExecutionCommand;
  envelope: CommandEnvelope<unknown>;
  send: (envelope: CommandEnvelope<unknown>) => Promise<PromptResult>;
  // Re-sends the SAME command id after a post-acceptance transport failure:
  // the host joins an in-flight turn, replays a completed one, or answers
  // `turn_lost` when the turn died with a restart (X-EH-09 / X-EH-15).
  lookupReceipt: (commandId: string) => Promise<CommandReceipt | null>;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
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

function receiptError(receipt: CommandReceipt): MaisterError {
  const body = receipt.body;
  const code = body.code === "FENCED" ? "CONFLICT" : "ACP_PROTOCOL";
  const message =
    typeof body.message === "string" ? body.message : "prompt rejected";

  return new MaisterError(code, message, {
    details: {
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      commandId: receipt.commandId,
    },
  });
}

// Canonical mode never waits for an ACP response. The accepted command/receipt
// is the admission result; terminal state arrives through a committed canonical
// event, or is recovered from the same host receipt after an acknowledgement
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
          await markFailed(opts.db, commandId, attempts, errorRecord(unavailable), {
            logger,
            now: now(),
          });
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
      if (receipt?.phase === "accepted") {
        await markAccepted(opts.db, commandId, attempts, { logger, now: now() });
        commandSignals.wake(commandId);
        return { commandId };
      }
      if (receipt?.phase === "completed") {
        await markSucceeded(opts.db, commandId, attempts, receipt.body, {
          logger,
          now: now(),
        });
        commandSignals.wake(commandId);
        return { commandId };
      }
      if (receipt?.phase === "rejected") {
        const errorFromReceipt = receiptError(receipt);
        await (isFencedError(errorFromReceipt) ? markFenced : markFailed)(
          opts.db,
          commandId,
          attempts,
          errorRecord(errorFromReceipt),
          { logger, now: now() },
        );
        commandSignals.wake(commandId);
        throw errorFromReceipt;
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

// Legacy-mode prompt delivery retains the synchronous host wire only as a
// compatibility adapter. Its outcome is durably folded into the command ledger;
// callers use `waitForPromptCompletion` rather than retaining this process's
// promise. Canonical runs use the asynchronous admission path in the client.
export function deliverPrompt(opts: DeliverPromptOptions): PromptHandle {
  const logger = opts.logger ?? defaultLog;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => new Date());
  const policy = COMMAND_POLICY["session.prompt"];
  const commandId = opts.command.id;
  let attempts = opts.command.attempts;
  let settled = false;

  // A ledger write failure is retained as a typed error and a recovery sweep
  // folds the receipt. It never leaves a serializable handle with an invented
  // in-memory result.
  const ledgerWrite = async (
    what: string,
    write: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await write();
    } catch (err) {
      logger.error(
        {
          commandId,
          commandKind: "session.prompt",
          transition: what,
          err: err instanceof Error ? err.message : String(err),
        },
        "command-ledger-write-failed",
      );
    }
  };

  const settleSuccess = async (result: PromptResult, source: string) => {
    if (settled) return;
    settled = true;
    unsubscribeLegacy();
    await ledgerWrite("succeeded", () =>
      markSucceeded(
        opts.db,
        commandId,
        null,
        { ...result },
        { logger, now: now() },
      ),
    );
    logger.info(
      {
        commandId,
        commandKind: "session.prompt",
        source,
        stopReason: result.stopReason,
        outcome: "succeeded",
      },
      "command-succeeded",
    );
    commandSignals.wake(commandId);
  };

  const settleFailure = async (err: MaisterError, source: string) => {
    if (settled) return;
    settled = true;
    unsubscribeLegacy();
    await ledgerWrite(isFencedError(err) ? "fenced" : "failed", () =>
      isFencedError(err)
        ? markFenced(opts.db, commandId, null, errorRecord(err), {
            logger,
            now: now(),
          })
        : markFailed(opts.db, commandId, null, errorRecord(err), {
            logger,
            now: now(),
          }),
    );
    logger.warn(
      {
        commandId,
        commandKind: "session.prompt",
        source,
        code: err.code,
        reason: err.details?.reason,
        outcome: isFencedError(err) ? "fenced" : "failed",
      },
      "command-failed",
    );
    commandSignals.wake(commandId);
  };

  const ledgerFailure = (err: unknown, source: string) =>
    settleFailure(
      new MaisterError(
        "ACP_PROTOCOL",
        `prompt ${commandId}: ledger error while ${source} — ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err, details: { reason: "ledger_write_failed", commandId } },
      ),
      source,
    );

  const unsubscribeLegacy = commandSignals.subscribeLegacy(
    commandId,
    (event) => {
      if (event.phase !== "accepted") return;
      void markAccepted(opts.db, commandId, null, { logger, now: now() })
        .then(() => commandSignals.wake(commandId))
        .catch((error: unknown) => {
          logger.error(
            {
              commandId,
              commandKind: "session.prompt",
              transition: "legacy-accepted",
              err: error instanceof Error ? error.message : String(error),
            },
            "command-ledger-write-failed",
          );
        });
    },
  );

  const drive = async (): Promise<void> => {
    for (;;) {
      const claimed = await claimDelivering(opts.db, commandId, attempts, {
        logger,
        now: now(),
      });

      if (!claimed.changed) {
        await settleFailure(
          new MaisterError(
            "CONFLICT",
            `command ${commandId} is no longer claimable`,
            {
              details: { reason: "command_not_claimable", commandId },
            },
          ),
          "claim",
        );

        return;
      }
      attempts = claimed.row?.attempts ?? attempts + 1;

      try {
        const result = await opts.send(opts.envelope);

        await settleSuccess(result, "http");

        return;
      } catch (err) {
        if (settled) return;

        if (isFencedError(err)) {
          await settleFailure(err as MaisterError, "http");

          return;
        }

        if (!isUnknownOutcome(err)) {
          await settleFailure(
            isMaisterError(err)
              ? err
              : new MaisterError("ACP_PROTOCOL", String(err)),
            "http",
          );

          return;
        }

        // Unknown outcome. Before acceptance: retry the same id within budget.
        // After acceptance: ONE receipt lookup decides (X-EH-15). A lookup
        // that itself fails on the wire (the host is restarting) is NOT a
        // 404 — it is retried with backoff until the host answers.
        let receipt: CommandReceipt | null = null;

        try {
          receipt = await lookupReceiptUntilReachable(
            opts.lookupReceipt,
            commandId,
            sleep,
          );
        } catch (lookupErr) {
          await settleFailure(
            new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              `prompt ${commandId}: the host stayed unreachable for the receipt lookup`,
              {
                cause: lookupErr,
                details: { reason: "receipt_lookup_failed", commandId },
              },
            ),
            "receipt",
          );

          return;
        }

        if (receipt?.phase === "completed") {
          await settleSuccess(
            receipt.body as unknown as PromptResult,
            "receipt",
          );

          return;
        }
        if (receipt?.phase === "rejected") {
          const body = receipt.body as {
            code?: string;
            message?: string;
            details?: Record<string, unknown>;
          };

          await settleFailure(
            new MaisterError(
              body.code === "FENCED"
                ? "CONFLICT"
                : ((body.code ?? "ACP_PROTOCOL") as MaisterError["code"]),
              body.message ?? "prompt rejected",
              { details: body.details },
            ),
            "receipt",
          );

          return;
        }
        if (receipt?.phase === "accepted") {
          if (!receipt.inflight) {
            // The host restarted mid-turn: nothing to join (X-EH-15).
            await settleFailure(
              new MaisterError(
                "ACP_PROTOCOL",
                "prompt turn lost after acceptance",
                {
                  cause: err,
                  details: { reason: "turn_lost", commandId },
                },
              ),
              "receipt",
            );

            return;
          }

          // The turn is still running on the host: re-send ONCE — the host
          // joins the live execution (or answers turn_lost if it just died).
          try {
            const joined = await opts.send(opts.envelope);

            await settleSuccess(joined, "join");
          } catch (joinErr) {
            await settleFailure(
              isMaisterError(joinErr) && !isUnknownOutcome(joinErr)
                ? joinErr
                : new MaisterError(
                    "ACP_PROTOCOL",
                    "prompt turn lost after acceptance",
                    {
                      cause: joinErr,
                      details: { reason: "turn_lost", commandId },
                    },
                  ),
              "join",
            );
          }

          return;
        }
        if (attempts >= policy.maxAttempts) {
          await settleFailure(
            new MaisterError(
              "EXECUTOR_UNAVAILABLE",
              `prompt ${commandId} exhausted its delivery budget`,
              {
                cause: err,
                details: { reason: "delivery_budget_exhausted" },
              },
            ),
            "http",
          );

          return;
        }

        await failRetryable(
          opts.db,
          commandId,
          attempts,
          errorRecord(err),
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
  };

  void drive().catch((err) => ledgerFailure(err, "delivering"));

  return { commandId };
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
  const fenced =
    error.code === "FENCED" ||
    (error.code === "CONFLICT" && error.reason === "assignment_fenced");
  const code = fenced ? "CONFLICT" : "ACP_PROTOCOL";
  const message =
    typeof error.message === "string"
      ? error.message
      : `prompt ${row.id} ${row.state}`;

  return new MaisterError(code, message, {
    details: {
      ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
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

export async function waitForPromptCompletion(input: {
  db: Db;
  handle: PromptHandle;
  signal?: AbortSignal;
}): Promise<PromptResult> {
  for (;;) {
    const row = await getCommand(input.db, input.handle.commandId);
    if (!row || row.kind !== "session.prompt") {
      throw new MaisterError("PRECONDITION", "prompt command is not available", {
        details: { reason: "prompt_command_missing", commandId: input.handle.commandId },
      });
    }
    if (row.state === "succeeded") return promptResultFromCommand(row);
    if (row.state === "failed" || row.state === "fenced") {
      throw promptFailureFromCommand(row);
    }
    await waitForCommandWake(row.id, input.signal);
  }
}
