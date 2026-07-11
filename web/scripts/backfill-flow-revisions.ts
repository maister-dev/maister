import "@/lib/load-env";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({
  name: "backfill-flow-revisions",
  level: process.env.LOG_LEVEL ?? "info",
});

export const BACKFILL_FLOW_REVISIONS_RETIRED_MESSAGE =
  "backfill-flow-revisions is retired after the graph-only cut-over; migration 0093 is the only supported upgrade path";

// This M10 bridge used to raw-cast flows.manifest and re-enable every flow.
// After the graph-only cut-over that behavior could revive legacy or
// engine-incompatible rows, so retain the command only as an explicit failure
// for operators who still have it in runbooks.
async function main(): Promise<void> {
  throw new MaisterError(
    "PRECONDITION",
    BACKFILL_FLOW_REVISIONS_RETIRED_MESSAGE,
  );
}

async function flushLogger(): Promise<void> {
  return new Promise((resolve) => {
    log.flush();
    setImmediate(resolve);
  });
}

main()
  .then(async () => {
    await flushLogger();
    process.exit(0);
  })
  .catch(async (err) => {
    if (isMaisterError(err)) {
      log.error({ code: err.code, message: err.message }, "backfill refused");
    } else {
      log.error({ err }, "backfill failed (unexpected)");
    }
    await flushLogger();
    process.exit(1);
  });
