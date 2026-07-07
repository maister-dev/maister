import "server-only";

import type { ExperimentStatus } from "@/lib/experiments/types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { experiments } from "@/lib/db/schema";
import { assertExperimentTransition } from "@/lib/experiments/fsm";

type DbTx = {
  update: (table: unknown) => {
    set: (values: Record<string, unknown>) => {
      where: (condition: unknown) => Promise<unknown>;
    };
  };
};

const log = pino({
  name: "experiments-repository",
  level: process.env.LOG_LEVEL ?? "info",
});

export function experimentStatusTimestampPatch(
  fromStatus: ExperimentStatus,
  toStatus: ExperimentStatus,
  now: Date,
): Record<string, unknown> {
  if (fromStatus === "draft" && toStatus === "running") {
    return { launchedAt: now };
  }

  if (toStatus === "comparable") return { comparableAt: now };
  if (toStatus === "concluded") return { concludedAt: now };
  if (toStatus === "abandoned") return { abandonedAt: now };

  return {};
}

export async function transitionExperimentStatus(
  tx: DbTx,
  args: {
    experimentId: string;
    fromStatus: ExperimentStatus;
    toStatus: ExperimentStatus;
    now: Date;
    reason?: string;
  },
): Promise<void> {
  assertExperimentTransition(args.fromStatus, args.toStatus);

  const set = {
    status: args.toStatus,
    updatedAt: args.now,
    ...experimentStatusTimestampPatch(args.fromStatus, args.toStatus, args.now),
  };

  log.info(
    {
      experimentId: args.experimentId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      reason: args.reason,
    },
    "experiment status transition",
  );

  await tx
    .update(experiments)
    .set(set)
    .where(
      and(
        eq(experiments.id, args.experimentId),
        eq(experiments.status, args.fromStatus),
      ),
    );
}
