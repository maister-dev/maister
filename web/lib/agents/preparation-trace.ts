import "server-only";

import type { OperationalProbeContext } from "./operational-diagnostics";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import pino from "pino";

import { operationalCauseChain } from "./operational-diagnostics";

const context = new AsyncLocalStorage<OperationalProbeContext>();
const log = pino({ name: "agent-workspace-operation" });

export function withPreparationTrace<T>(
  owner: OperationalProbeContext,
  effect: () => Promise<T>,
): Promise<T> {
  return context.run(owner, effect);
}

/** Correlate operations without repository paths, arbitrary stderr or source bytes. */
export async function tracePreparationOperation<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<T> {
  const fields = {
    ...context.getStore(),
    operationId: randomUUID(),
    operation,
  };
  const start = performance.now();

  log.info({ ...fields, outcome: "started" }, "workspace-operation");
  try {
    const result = await effect();

    log.info(
      {
        ...fields,
        outcome: "completed",
        durationMs: Math.round(performance.now() - start),
      },
      "workspace-operation",
    );

    return result;
  } catch (error) {
    log.warn(
      {
        ...fields,
        outcome: "failed",
        durationMs: Math.round(performance.now() - start),
        causeChain: operationalCauseChain(error),
      },
      "workspace-operation",
    );
    throw error;
  }
}
