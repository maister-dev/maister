import "server-only";

import type { ExecutionHosts } from "@/lib/execution-host/client";
import type { WaitAddress, WaitDb, WaitTx } from "@/lib/waits/store";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { runs, runWaits } from "@/lib/db/schema";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { executionHosts } from "@/lib/execution-host/client";
import { resolveEligibleConditionWait } from "@/lib/waits/lifecycle";

const log = pino({
  name: "condition-wait-resolve",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function resolveObservedWait(
  db: WaitDb & Pick<WaitTx, "select">,
  address: WaitAddress,
  hosts: Pick<ExecutionHosts, "forAssignment"> = executionHosts,
): Promise<boolean> {
  const [candidate] = await db
    .select({
      assignmentId: runs.executionAssignmentId,
      head: runWaits.bindingHeadSha,
      kind: runWaits.conditionKind,
    })
    .from(runWaits)
    .innerJoin(runs, eq(runs.id, runWaits.runId))
    .where(
      and(
        eq(runWaits.id, address.waitId),
        eq(runWaits.projectId, address.projectId),
        eq(runWaits.runId, address.runId),
        eq(runWaits.state, "open"),
      ),
    );

  if (!candidate) return false;
  let observedHeadSha: string | undefined;

  if (candidate.kind === "signal" && candidate.head && candidate.assignmentId) {
    try {
      const client = await hosts.forAssignment({ id: candidate.assignmentId });

      ({ headSha: observedHeadSha } = await client.observeWaitWorkspaceHead(
        address.waitId,
      ));
    } catch (error: unknown) {
      // A missing host observation cannot settle a bound report. The stored
      // deadline remains eligible, including when its execution host is down.
      log.warn(
        { ...address, ...queryErrorDiagnostics(error) },
        "bound wait head observation unavailable",
      );
    }
  }

  return db.transaction((tx) =>
    resolveEligibleConditionWait(tx, address, observedHeadSha),
  );
}
