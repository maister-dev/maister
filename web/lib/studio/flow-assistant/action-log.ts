import "server-only";

import type {
  FlowActionResultPayload,
  FlowAssistantAction,
  FlowAssistantActionOperation,
} from "./protocol";

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { flowAssistantActionLogPath } from "./run-artifacts";

const log = pino({
  name: "studio/flow-assistant/action-log",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowAssistantActionLogState =
  | "received"
  | "validated"
  | "applied"
  | "rejected"
  | "interrupted";

export type FlowAssistantActionLogRecord = {
  v: 1;
  at: string;
  runId: string;
  localPackageId: string;
  actionId: string;
  state: FlowAssistantActionLogState;
  summary: string;
  operations: RedactedOperation[];
  status?: FlowActionResultPayload["status"];
  issueCount?: number;
  issues?: string[];
  operationIndex?: number;
  message?: string;
};

type RedactedOperation = {
  op: FlowAssistantActionOperation["op"];
  path: string;
  baseHash: string | null;
  contentHash?: string;
  contentBytes?: number;
};

export async function appendFlowAssistantActionLog(args: {
  localPackageSlug: string;
  localPackageId: string;
  runId: string;
  state: FlowAssistantActionLogState;
  action: FlowAssistantAction;
  result?: FlowActionResultPayload;
  issues?: readonly string[];
  operationIndex?: number;
  message?: string;
}): Promise<void> {
  const file = flowAssistantActionLogPath({
    localPackageSlug: args.localPackageSlug,
    runId: args.runId,
  });
  const record: FlowAssistantActionLogRecord = {
    v: 1,
    at: new Date().toISOString(),
    runId: args.runId,
    localPackageId: args.localPackageId,
    actionId: args.action.actionId,
    state: args.state,
    summary: args.action.summary,
    operations: args.action.operations.map(redactOperation),
    status: args.result?.status,
    issueCount: args.result?.issueCount ?? args.issues?.length,
    issues: (args.result?.issues ?? args.issues)?.slice(0, 20),
    operationIndex: args.operationIndex,
    message: args.message ?? args.result?.message ?? undefined,
  };

  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  log.info(
    {
      localPackageId: args.localPackageId,
      runId: args.runId,
      actionId: args.action.actionId,
      state: args.state,
      operationCount: args.action.operations.length,
      status: record.status,
      issueCount: record.issueCount ?? 0,
    },
    "flow assistant action log appended",
  );
}

function redactOperation(
  operation: FlowAssistantActionOperation,
): RedactedOperation {
  if (operation.op === "delete_file") {
    return {
      op: operation.op,
      path: operation.path,
      baseHash: operation.baseHash,
    };
  }

  return {
    op: operation.op,
    path: operation.path,
    baseHash: operation.baseHash,
    contentHash: sha256(operation.content),
    contentBytes: Buffer.byteLength(operation.content, "utf8"),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
