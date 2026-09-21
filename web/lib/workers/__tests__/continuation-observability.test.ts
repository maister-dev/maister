import type { Db } from "@/lib/execution-host/db";

import { beforeEach, describe, expect, it, vi } from "vitest";

// Both continuation workers use a module-scoped pino, so owning the factory for
// this file is the only way to assert the LINES rather than the values behind
// them. The prompt-owner worker already logged its own start/stop; these two
// were silent and carried no worker identity, which made a degraded slot
// unattributable in a multi-worker boot.
const logLines = vi.hoisted(
  () => [] as Array<{ payload: Record<string, unknown>; msg: unknown }>,
);

vi.mock("pino", () => {
  const record =
    () =>
    (payload: Record<string, unknown>, msg?: unknown): void => {
      logLines.push({ payload, msg });
    };
  const logger = {
    info: record(),
    error: record(),
    warn: record(),
    debug: record(),
    trace: record(),
    fatal: record(),
    child: () => logger,
    level: "info",
  };

  return { default: () => logger };
});

// Not a Pool, so `projectionTransaction` refuses immediately: every pass errors
// and parks in the 1 s wake wait, which `stop()`'s abort resolves — a clean
// shutdown without a database.
const brokenDb = {} as unknown as Db;

function lineFor(msg: string): Record<string, unknown> | undefined {
  return logLines.find((line) => line.msg === msg)?.payload;
}

beforeEach(() => {
  logLines.length = 0;
});

describe("continuation worker start/stop observability", () => {
  it("the flow worker announces its identity and slot count, and its stop", async () => {
    const { startFlowContinuationWorker } = await import(
      "@/lib/flows/graph/continuation-worker"
    );
    const worker = startFlowContinuationWorker({ db: brokenDb });
    const started = lineFor("flow-continuation-worker-started");

    expect(started, "start must be announced synchronously").toBeDefined();
    expect(started?.workerId).toMatch(
      /^flow-continuation-worker:[0-9a-f-]{36}$/,
    );
    expect(started?.concurrency).toBe(2);

    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    const stopped = lineFor("flow-continuation-worker-stopped");

    expect(stopped?.workerId).toBe(started?.workerId);
    // A degraded slot must be attributable to the worker that degraded.
    const degraded = lineFor("flow-continuation-worker-degraded");

    expect(degraded?.workerId).toBe(started?.workerId);
    expect(degraded?.slot).toBeTypeOf("number");
  });

  it("the agent worker announces its single loop and its stop", async () => {
    const { startAgentContinuationWorker } = await import(
      "@/lib/agents/continuation-worker"
    );
    const worker = startAgentContinuationWorker({ db: brokenDb });
    const started = lineFor("agent-continuation-worker-started");

    expect(started, "start must be announced synchronously").toBeDefined();
    expect(started?.workerId).toMatch(
      /^agent-continuation-worker:[0-9a-f-]{36}$/,
    );
    // One loop, not the two slots its siblings take from the projection limits.
    expect(started?.concurrency).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(lineFor("agent-continuation-worker-stopped")?.workerId).toBe(
      started?.workerId,
    );
    expect(lineFor("agent-continuation-worker-degraded")?.workerId).toBe(
      started?.workerId,
    );
  });
});
