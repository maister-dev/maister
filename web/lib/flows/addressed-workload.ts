import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionCommand } from "@/lib/db/schema";
import type { WorkspaceInputObject } from "../../../runtime/workspace-prepare";
import type { FlowDriverClaim } from "./graph/driver-claim";
import type { StepResult } from "./types";

import pino from "pino";

import {
  WORKSPACE_TEMPLATE_CONTEXT_MAX_BYTES,
  WORKSPACE_TEMPLATE_CONTEXT_NAME,
  workspaceEvidenceDigest,
} from "../../../runtime/workspace-prepare";
import { canonicalCommandJson } from "../../../runtime/command-json";

import { readSealedCliOutput } from "./graph/node-output";
import {
  assertFlowDriverClaim,
  FlowDriverClaimLost,
} from "./graph/driver-claim";

import { MaisterError } from "@/lib/errors";
import { getCommand } from "@/lib/execution-host/commands";
import { createExecutionHosts } from "@/lib/execution-host";
import { runEventWakeBus } from "@/lib/execution-host/events/run-wake";
import {
  getRuntimeObjectForRun,
  deterministicRuntimeObjectId,
  publishRuntimeObject,
  readRuntimeObjectContent,
} from "@/lib/execution-host/runtime-objects";
import {
  WorkspaceWorkloadPayloadSchema,
  WorkspaceWorkloadResultSchema,
} from "@/lib/execution-host/workspace-prepare-schema";
import { dispatchQueuedWorkspaceCommand } from "@/lib/execution-host/workspace-dispatch";
import {
  reserveWorkspaceWorkload,
  workspaceWorkloadCommandId,
} from "@/lib/execution-host/workspace-workloads";
import { assertWorkspaceRunAuthority } from "@/lib/execution-host/workspace-input-authority";

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

export function flowWorkloadTarget(
  db: Db | undefined,
  claim: FlowDriverClaim | undefined,
  assignmentId: string | null,
  input: Pick<
    AddressedCliWorkload,
    "declarationId" | "operationKey" | "workload"
  >,
): AddressedCliWorkload {
  if (
    !db ||
    claim?.scope !== "assignment" ||
    claim.assignmentId !== assignmentId
  )
    throw new MaisterError(
      "PRECONDITION",
      "Addressed command requires its assigned Flow driver",
    );

  return { ...input, db, assignmentId: claim.assignmentId };
}

/** An unsettled command still owns its workspace. The traversal must yield. */
export class FlowWorkloadContinuationPending extends MaisterError {
  constructor(commandId: string) {
    super("PRECONDITION", "Flow workload awaits durable host evidence", {
      details: { reason: "flow_workload_continuation_pending", commandId },
    });
  }
}

type CliOutput = Pick<StepResult, "stdout" | "stderr" | "originalOutput">;

async function sealTemplateContext(
  work: AddressedCliWorkload,
  runId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<WorkspaceInputObject> {
  let content: unknown;
  let bytes: Buffer;
  try {
    content = JSON.parse(
      JSON.stringify({ version: 1, declarationId: work.declarationId, values }),
    );
    bytes = Buffer.from(canonicalCommandJson(content));
  } catch {
    throw new MaisterError(
      "CONFIG",
      "The addressed workload template context must be JSON",
      {
        details: { reason: "workspace_template_context_invalid" },
      },
    );
  }
  if (bytes.byteLength > WORKSPACE_TEMPLATE_CONTEXT_MAX_BYTES)
    throw new MaisterError(
      "CONFIG",
      "The addressed workload template context exceeds 128 KiB",
      {
        details: { reason: "workspace_template_context_invalid" },
      },
    );
  await assertWorkspaceRunAuthority(work.db, runId);
  const client = await createExecutionHosts({ db: work.db }).forAssignment({
    id: work.assignmentId,
  });
  const sha256 = workspaceEvidenceDigest(content);
  const published = await publishRuntimeObject({
    client,
    objectId: deterministicRuntimeObjectId({
      runId,
      sourceKey: `workspace-template:${work.assignmentId}:${work.operationKey}`,
      sha256,
    }),
    kind: "capability_profile",
    logicalName: WORKSPACE_TEMPLATE_CONTEXT_NAME,
    mimeType: "application/json",
    retentionClass: "run",
    bytes,
  });

  return { objectId: published.objectId, sha256 };
}

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
    templateValues?: Readonly<Record<string, unknown>>;
    driver?: Readonly<{ claim: FlowDriverClaim; signal: AbortSignal }>;
  }>,
): Promise<StepResult> {
  const { db } = work;
  const { runId, driver } = input;
  const startedAt = Date.now();
  if (driver?.signal.aborted) throw new FlowDriverClaimLost(driver.claim);
  const existing = input.templateValues
    ? await getCommand(db, workspaceWorkloadCommandId({ ...work, runId }))
    : null;
  const templateContext = existing
    ? WorkspaceWorkloadPayloadSchema.parse(existing.payload).templateContext
    : input.templateValues
      ? await sealTemplateContext(work, runId, input.templateValues)
      : undefined;
  if (input.templateValues && !templateContext)
    throw new MaisterError(
      "CONFLICT",
      "The addressed workload has no retained template context",
    );
  const admitted = await reserveWorkspaceWorkload(db, {
    ...work,
    runId,
    templateContext,
    ...(driver
      ? { assertDriver: (tx: Db) => assertFlowDriverClaim(tx, driver.claim) }
      : {}),
  });
  const deadline = AbortSignal.timeout(input.timeoutMs + 30_000);
  const signal = driver ? AbortSignal.any([deadline, driver.signal]) : deadline;
  if (admitted.state === "queued") {
    try {
      await dispatchQueuedWorkspaceCommand(db, {
        runId,
        commandId: admitted.id,
      });
    } catch (error) {
      if (
        !(error instanceof MaisterError) ||
        error.code !== "EXECUTOR_UNAVAILABLE"
      )
        throw error;
      log.warn(
        { runId, commandId: admitted.id, reason: error.details?.reason },
        "workspace workload delivery awaits recovery",
      );
    }
  }
  while (!signal.aborted) {
    const settled = await getCommand(db, admitted.id);
    const refusal = settled?.lastError?.details;
    if (
      settled?.state === "failed" &&
      typeof refusal === "object" &&
      refusal !== null &&
      "reason" in refusal &&
      refusal.reason === "workspace_template_context_invalid"
    )
      throw new MaisterError(
        "CONFIG",
        "The selected supervisor could not render the declared workload",
        {
          details: { reason: "workspace_template_context_invalid" },
        },
      );
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
