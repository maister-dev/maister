import "server-only";

import { inArray } from "drizzle-orm";
import pino from "pino";

import { projectRunEvents } from "./artifact-projector";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants (matches the store/ledger idiom).
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "projector-catch-up-sweep",
  level: process.env.LOG_LEVEL ?? "info",
});

const IN_FLIGHT_STATUSES = [
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
  "Review",
];

export async function runProjectorCatchUpSweep(opts?: {
  db?: Db;
  limit?: number;
}): Promise<{ candidatesFound: number; projected: number }> {
  const d = opts?.db ?? getDb();
  const limit = opts?.limit ?? 50;

  // Single bounded boot pass, not a drain loop: the LIMIT has no ORDER BY and
  // projecting a run does not move it out of the in-flight set, so repeated
  // small-limit passes are not guaranteed to cover every run. The boot default
  // (50) comfortably exceeds realistic in-flight counts; idempotent on re-run.
  const candidates = (await d
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, IN_FLIGHT_STATUSES))
    .limit(limit)) as Array<{ id: string }>;

  let projected = 0;

  for (const { id: runId } of candidates) {
    try {
      const r = await projectRunEvents(runId, { db: d });

      projected += r.projected;
    } catch (err) {
      log.warn(
        { runId, err: (err as Error).message },
        "projector catch-up: run failed",
      );
    }
  }

  log.info(
    { candidatesFound: candidates.length, projected },
    "projector catch-up sweep complete",
  );

  return { candidatesFound: candidates.length, projected };
}
