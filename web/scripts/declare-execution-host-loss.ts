import "@/lib/load-env";

import { parseArgs } from "node:util";

import pino from "pino";

import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import {
  declareExecutionHostLoss,
  executionHostLossSchema,
} from "@/lib/execution-host/host-loss";

const log = pino({ name: "declare-execution-host-loss" });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "host-key": { type: "string" },
      "observed-boot": { type: "string" },
      "operator-id": { type: "string" },
      "isolation-evidence": { type: "string" },
      apply: { type: "boolean" },
    },
  });
  const parsed = executionHostLossSchema.safeParse({
    hostKey: values["host-key"],
    observedBootId: values["observed-boot"],
    operatorId: values["operator-id"],
    isolationEvidenceRef: values["isolation-evidence"],
  });
  if (!values.apply || !parsed.success)
    throw new MaisterError(
      "PRECONDITION",
      "Supply --host-key, --observed-boot, --operator-id, --isolation-evidence and --apply after externally isolating the host",
    );
  try {
    const result = await declareExecutionHostLoss(getDb(), parsed.data);
    log.info(result, "execution-host-loss-settled");
  } finally {
    await closeDb();
  }
}

void main().catch((error: unknown) => {
  log.error(
    {
      code: error instanceof MaisterError ? error.code : "UNEXPECTED",
      message:
        error instanceof MaisterError
          ? error.message
          : "Host loss could not be recorded",
    },
    "execution-host-loss-refused",
  );
  process.exitCode = 1;
});
