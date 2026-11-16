import "@/lib/load-env";

import pino from "pino";

import { isMaisterError } from "@/lib/errors";
import { runTaskSourceBackfill } from "@/lib/tasks/external-source/backfill";

// ADR-206: bind legacy marker-only GitHub intake tasks to structured source
// identities. Dry-run unless `--apply`; the JSON report goes to stdout.
const log = pino({
  name: "backfill-task-sources",
  level: process.env.LOG_LEVEL ?? "info",
});

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

runTaskSourceBackfill({ apply: process.argv.includes("--apply") })
  .then(async (report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error(
      isMaisterError(err) ? { code: err.code, message: err.message } : { err },
      "task source backfill failed",
    );
    await flushLogger();
    process.exit(1);
  });
