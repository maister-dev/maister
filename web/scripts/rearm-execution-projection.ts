import "@/lib/load-env";

import { parseArgs } from "node:util";

import pino from "pino";
import { z } from "zod";

import { closeDb, getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { rearmExecutionProjection } from "@/lib/execution-host/events/projector";

const log = pino({ name: "execution-projection-rearm" });

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      consumer: { type: "string" },
      run: { type: "string" },
      event: { type: "string" },
      cursor: { type: "string" },
      "error-generation": { type: "string" },
    },
  });
  const parsed = z
    .object({
      consumer: z.string().min(1).max(256),
      run: z.string().min(1).max(256),
      event: z.string().min(1).max(256),
      cursor: z.union([z.literal("null"), z.string().regex(/^\d{1,19}$/)]),
      "error-generation": z.string().uuid(),
    })
    .safeParse(values);

  if (!parsed.success)
    throw new MaisterError(
      "PRECONDITION",
      "supply --consumer, --run, --event, --cursor (decimal or null), and --error-generation",
    );
  const cursor =
    parsed.data.cursor === "null" ? null : BigInt(parsed.data.cursor);

  if (cursor !== null && cursor > 9_223_372_036_854_775_807n)
    throw new MaisterError(
      "PRECONDITION",
      "projection cursor exceeds PostgreSQL BIGINT",
    );
  try {
    await rearmExecutionProjection({
      db: getDb(),
      consumerName: parsed.data.consumer,
      runId: parsed.data.run,
      eventId: parsed.data.event,
      expectedCursor: cursor,
      errorGeneration: parsed.data["error-generation"],
    });
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
          : "projection rearm failed",
    },
    "projection-rearm-refused",
  );
  process.exitCode = 1;
});
