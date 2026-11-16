import "@/lib/load-env";

import pino from "pino";

import { isMaisterError } from "@/lib/errors";
import { reconcileMergedTaskCompletion } from "@/lib/tasks/reconcile-merged-completion";

// ADR-207: complete InFlight tasks whose newest flow Run merged before the
// run.pr_merged event existed. Dry-run unless `--apply`; JSON report on stdout.
const log = pino({
  name: "reconcile-merged-task-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

reconcileMergedTaskCompletion({ apply: process.argv.includes("--apply") })
  .then(async (report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error(
      isMaisterError(err) ? { code: err.code, message: err.message } : { err },
      "merged task completion reconciliation failed",
    );
    await flushLogger();
    process.exit(1);
  });
