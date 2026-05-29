import "@/lib/load-env";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";
import { MaisterError, isMaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (see flows.ts).
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "run-flow",
  level: process.env.LOG_LEVEL ?? "info",
});

type CliArgs = {
  taskId: string;
  executorOverrideId?: string;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new MaisterError(
        "CONFIG",
        `Bad argv near "${flag}". Usage: --task <id> [--executor-override <id>]`,
      );
    }
    out[flag.slice(2)] = value;
  }

  if (!out.task) {
    throw new MaisterError("CONFIG", "Missing required --task <id>");
  }

  return {
    taskId: out.task,
    executorOverrideId: out["executor-override"],
  };
}

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const taskRows: Array<{ id: string; status: string }> = await (
    db as unknown as {
      select: any;
    }
  )
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, args.taskId));

  if (taskRows.length === 0) {
    throw new MaisterError("PRECONDITION", `task not found: ${args.taskId}`);
  }

  const runRows: Array<{ id: string; status: string }> = await (
    db as unknown as { select: any }
  )
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(eq(runs.taskId, args.taskId));

  const targetRun = runRows.find((r) => r.status === "Pending");

  if (!targetRun) {
    throw new MaisterError(
      "PRECONDITION",
      `no Pending run found for task ${args.taskId} — create one via POST /api/runs first`,
    );
  }

  log.info({ taskId: args.taskId, runId: targetRun.id }, "starting run");

  const start = await tryStartRun(targetRun.id);

  if (!start.started) {
    log.info(
      { runId: targetRun.id, queuePosition: start.queuePosition },
      "run queued (concurrency cap)",
    );

    return;
  }

  await runFlow(targetRun.id);

  const after: Array<{ status: string }> = await (
    db as unknown as { select: any }
  )
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, targetRun.id));

  const finalStatus = after[0]?.status;

  log.info({ runId: targetRun.id, status: finalStatus }, "run finished");

  if (finalStatus === "Failed" || finalStatus === "Crashed") {
    process.exit(1);
  }
}

main()
  .then(async () => {
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    if (isMaisterError(err)) {
      log.error(
        {
          code: err.code,
          message: err.message,
          cause: (err.cause as Error)?.message,
        },
        "run-flow failed",
      );
    } else {
      log.error({ err }, "run-flow failed (unexpected)");
    }
    await flushLogger();
    process.exit(1);
  });
