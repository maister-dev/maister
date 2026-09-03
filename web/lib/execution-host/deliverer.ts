import type { Db } from "./db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { PromptResult } from "@/lib/supervisor-client";
import type { CommandReceipt } from "./contracts";
import type { SessionCommandEvent } from "./signals";
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
  completion: Promise<PromptResult>;
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

// ADR-166 D5 for `session.prompt`: the long-lived HTTP response, the SSE
// `session.command` event, and the receipt are all durable completion
// signals; the first one to arrive wins and later folds are no-ops.
export function deliverPrompt(opts: DeliverPromptOptions): PromptHandle {
  const logger = opts.logger ?? defaultLog;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => new Date());
  const policy = COMMAND_POLICY["session.prompt"];
  const commandId = opts.command.id;
  let attempts = opts.command.attempts;
  let accepted = false;
  let settled = false;
  let resolveCompletion!: (r: PromptResult) => void;
  let rejectCompletion!: (e: unknown) => void;
  const completion = new Promise<PromptResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const settleSuccess = async (result: PromptResult, source: string) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    await markSucceeded(
      opts.db,
      commandId,
      null,
      { ...result },
      { logger, now: now() },
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
    resolveCompletion(result);
  };

  const settleFailure = async (err: MaisterError, source: string) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    if (isFencedError(err)) {
      await markFenced(opts.db, commandId, null, errorRecord(err), {
        logger,
        now: now(),
      });
    } else {
      await markFailed(opts.db, commandId, null, errorRecord(err), {
        logger,
        now: now(),
      });
    }
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
    rejectCompletion(err);
  };

  const onSignal = (event: SessionCommandEvent) => {
    void (async () => {
      if (event.phase === "accepted") {
        if (!accepted) {
          accepted = true;
          await markAccepted(opts.db, commandId, null, { logger, now: now() });
        }

        return;
      }

      if (event.status === "succeeded") {
        await settleSuccess(event.result as PromptResult, "sse");
      } else {
        const body = event.error ?? {
          code: "ACP_PROTOCOL",
          message: "prompt failed",
        };
        const code =
          body.code === "FENCED"
            ? "CONFLICT"
            : (body.code as MaisterError["code"]);

        await settleFailure(
          new MaisterError(code, body.message, { details: body.details }),
          "sse",
        );
      }
    })();
  };
  const unsubscribe = commandSignals.subscribe(commandId, onSignal);

  void (async () => {
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
        if (accepted) {
          // SSE said accepted but the host has no receipt: the turn cannot be
          // recovered by re-sending (a fresh execution would double-run it).
          await settleFailure(
            new MaisterError(
              "ACP_PROTOCOL",
              `prompt ${commandId} accepted but its receipt is missing`,
              {
                cause: err,
                details: { reason: "receipt_missing", commandId },
              },
            ),
            "receipt",
          );

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
  })();

  return { commandId, completion };
}

export async function currentCommand(db: Db, id: string) {
  return getCommand(db, id);
}
