import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { WorkspaceInputObject } from "../../../runtime/workspace-prepare";
import type { FlowDriverClaim } from "./graph/driver-claim";
import type { StepResult } from "./types";

import pino from "pino";

import { readSealedCliOutput } from "./graph/node-output";
import {
  assertFlowDriverClaim,
  FlowDriverClaimLost,
} from "./graph/driver-claim";

import { MaisterError } from "@/lib/errors";
import { getCommand } from "@/lib/execution-host/commands";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import {
  getRuntimeObjectForRun,
  readRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";
import { WorkspaceWorkloadResultSchema } from "@/lib/execution-host/workspace-prepare-schema";
import { reserveWorkspaceWorkload } from "@/lib/execution-host/workspace-workloads";

const log = pino({
  name: "addressed-workload",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AddressedCliWorkload = Readonly<{
  db: Db;
  assignmentId: string;
  operationKey: string;
  declarationId: string;
  workload: "cli" | "check";
}>;

/** An unsettled command still owns its workspace. The traversal must yield. */
export class FlowWorkloadContinuationPending extends MaisterError {
  constructor(commandId: string) {
    super("PRECONDITION", "Flow workload awaits durable host evidence", {
      details: { reason: "flow_workload_continuation_pending", commandId },
    });
  }
}

type CliOutput = Pick<StepResult, "stdout" | "stderr" | "originalOutput">;

async function readWorkloadOutputs(
  db: Db,
  command: ExecutionCommand,
  references: readonly WorkspaceInputObject[],
  signal: AbortSignal,
): Promise<CliOutput | null> {
  const { runId } = command;
  const records = new Map<string, WorkspaceInputObject>();
  let textSize = 0n;
  for (const reference of references) {
    const metadata = await getRuntimeObjectForRun({
      db,
      runId,
      objectId: reference.objectId,
    });
    if (!metadata || metadata.object.state === "pending") return null;
    const { object } = metadata;
    const structured = object.logicalName === "workload-result.json";
    if (!structured) textSize += object.sizeBytes ?? 0n;
    if (
      object.executionAssignmentId !== command.executionAssignmentId ||
      object.executionHostId !== command.executionHostId ||
      object.sha256 !== reference.sha256 ||
      object.kind !== "diagnostic" ||
      object.sizeBytes === null ||
      textSize > 4 * 1024 * 1024 ||
      records.has(object.logicalName) ||
      (structured
        ? object.mimeType !== "application/json" || object.sizeBytes > 262_144
        : !["workload-stdout.txt", "workload-stderr.txt"].includes(
            object.logicalName,
          ) || object.mimeType !== "text/plain")
    )
      throw new MaisterError(
        "ACP_PROTOCOL",
        "Workspace workload output differs from its sealed receipt",
      );
    records.set(object.logicalName, reference);
  }

  const readText = async (logicalName: string): Promise<string> => {
    const reference = records.get(logicalName);
    if (!reference) return "";
    const { content } = await readRuntimeObjectContent({
      db,
      runId,
      objectId: reference.objectId,
      signal,
    });

    return new TextDecoder().decode(content.bytes);
  };
  const structured = records.get("workload-result.json");
  const stdout = await readText("workload-stdout.txt");
  const stderr = await readText("workload-stderr.txt");
  const originalOutput = structured
    ? await readSealedCliOutput({ db, runId, ...structured, signal })
    : undefined;

  return { stdout, stderr, originalOutput };
}

/** Run a previously sealed declaration using only host ledger and object receipts. */
export async function runAddressedCliWorkload(
  work: AddressedCliWorkload,
  input: Readonly<{
    runId: string;
    timeoutMs: number;
    driver?: Readonly<{ claim: FlowDriverClaim; signal: AbortSignal }>;
  }>,
): Promise<StepResult> {
  const { db } = work;
  const { runId, driver } = input;
  const startedAt = Date.now();
  const admitted = await reserveWorkspaceWorkload(db, {
    ...work,
    runId,
    ...(driver
      ? { assertDriver: (tx: Db) => assertFlowDriverClaim(tx, driver.claim) }
      : {}),
  });
  const deadline = AbortSignal.timeout(input.timeoutMs + 30_000);
  const signal = driver ? AbortSignal.any([deadline, driver.signal]) : deadline;
  while (!signal.aborted) {
    const settled = await getCommand(db, admitted.id);
    if (
      !settled ||
      settled.state === "failed" ||
      settled.transportState === "reconciliation_required"
    )
      throw new FlowWorkloadContinuationPending(admitted.id);
    if (settled.state === "succeeded") {
      const {
        eventId: _eventId,
        outcomeSha256: _outcomeSha256,
        ...stored
      } = settled.result ?? {};
      const result = WorkspaceWorkloadResultSchema.safeParse(stored);
      if (!result.success || result.data.quiescence !== "proved")
        throw new FlowWorkloadContinuationPending(admitted.id);
      const output = await readWorkloadOutputs(
        db,
        settled,
        result.data.objects,
        signal,
      ).catch((error: unknown) => {
        if (signal.aborted) return null;
        if (
          error instanceof MaisterError &&
          error.details?.reason === "command_in_progress"
        ) {
          log.warn(
            { runId, commandId: admitted.id },
            "workload output verification is busy",
          );

          return null;
        }
        throw error;
      });
      if (output && !signal.aborted) {
        const ok =
          result.data.processOutcome === "exited" && result.data.exitCode === 0;

        return {
          ...output,
          ok,
          exitCode: result.data.exitCode ?? undefined,
          ...(ok
            ? {}
            : {
                errorCode:
                  result.data.processOutcome === "interrupted"
                    ? "CRASH"
                    : "PRECONDITION",
              }),
          durationMs: Date.now() - startedAt,
          vars: {},
        };
      }
    }
    await runEventWakeBus.wait(runId, 2_000, signal);
  }
  if (driver?.signal.aborted) throw new FlowDriverClaimLost(driver.claim);

  throw new FlowWorkloadContinuationPending(admitted.id);
}
