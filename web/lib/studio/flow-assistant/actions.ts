import "server-only";

import type { LocalPackage } from "@/lib/db/schema";
import type { PackageArtifactFile } from "@/lib/local-packages/validate";

import { createHash } from "node:crypto";

import pino from "pino";

import {
  createAppliedActionResult,
  createRejectedActionResult,
  type FlowActionResultPayload,
  type FlowAssistantAction,
} from "./protocol";

import { MaisterError } from "@/lib/errors";
import { readWorkingDirArtifactFiles } from "@/lib/local-packages/service";
import { resolveWithinWorkingDir } from "@/lib/local-packages/paths";
import { validatePackageArtifacts } from "@/lib/local-packages/validate";

const log = pino({
  name: "studio/flow-assistant/actions",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowAssistantActionValidation =
  | {
      ok: true;
      action: FlowAssistantAction;
      result: FlowActionResultPayload;
      virtualFiles: PackageArtifactFile[];
      changedPaths: string[];
    }
  | {
      ok: false;
      result: FlowActionResultPayload;
    };

export async function validateFlowAssistantAction(args: {
  localPackage: LocalPackage;
  runId: string;
  action: FlowAssistantAction;
}): Promise<FlowAssistantActionValidation> {
  const currentFiles = await readWorkingDirArtifactFiles(args.localPackage);
  const currentByPath = new Map(
    currentFiles.map((file) => [file.path, file.content]),
  );
  const pathIssue = await validateActionPaths(args.localPackage, args.action);

  if (pathIssue !== null) {
    return reject({
      action: args.action,
      status: "rejected",
      issues: [pathIssue],
      message:
        "I did not change files because the action referenced an unsafe path.",
    });
  }

  const duplicateIssue = firstDuplicatePath(args.action);

  if (duplicateIssue !== null) {
    return reject({
      action: args.action,
      status: "invalid",
      issues: [duplicateIssue],
      message:
        "I did not change files because the action edited the same path twice.",
    });
  }

  const staleIssues = findStaleHashIssues(currentByPath, args.action);

  if (staleIssues.length > 0) {
    log.warn(
      {
        localPackageId: args.localPackage.id,
        runId: args.runId,
        actionId: args.action.actionId,
        issueCount: staleIssues.length,
      },
      "flow assistant action rejected as stale",
    );

    return reject({
      action: args.action,
      status: "stale",
      issues: staleIssues,
      message:
        "I did not change files because the package changed after the assistant read it.",
    });
  }

  const virtualFiles = applyToVirtualFiles(currentFiles, args.action);
  const changedPaths = Array.from(
    new Set(args.action.operations.map((operation) => operation.path)),
  );
  const validationIssues = validatePackageArtifacts({
    files: virtualFiles,
    changedPaths,
  }).map((issue) => `${issue.path}: ${issue.message}`);

  if (validationIssues.length > 0) {
    log.warn(
      {
        localPackageId: args.localPackage.id,
        runId: args.runId,
        actionId: args.action.actionId,
        issueCount: validationIssues.length,
      },
      "flow assistant action rejected by package validation",
    );

    return reject({
      action: args.action,
      status: "invalid",
      issues: validationIssues,
      message:
        "I did not change files because the proposed package state is invalid.",
    });
  }

  log.info(
    {
      localPackageId: args.localPackage.id,
      runId: args.runId,
      actionId: args.action.actionId,
      operationCount: args.action.operations.length,
    },
    "flow assistant action validated",
  );

  return {
    ok: true,
    action: args.action,
    result: createAppliedActionResult({ action: args.action }),
    virtualFiles,
    changedPaths,
  };
}

export function packageFileHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function validateActionPaths(
  pkg: LocalPackage,
  action: FlowAssistantAction,
): Promise<string | null> {
  for (const operation of action.operations) {
    try {
      await resolveWithinWorkingDir(pkg.workingDir, operation.path);
    } catch (err) {
      return err instanceof MaisterError
        ? `${operation.path}: ${err.message}`
        : `${operation.path}: invalid path`;
    }
  }

  return null;
}

function firstDuplicatePath(action: FlowAssistantAction): string | null {
  const seen = new Set<string>();

  for (const operation of action.operations) {
    if (seen.has(operation.path)) {
      return `${operation.path}: path appears more than once in one action`;
    }
    seen.add(operation.path);
  }

  return null;
}

function findStaleHashIssues(
  currentByPath: ReadonlyMap<string, string>,
  action: FlowAssistantAction,
): string[] {
  const issues: string[] = [];

  for (const operation of action.operations) {
    const currentContent = currentByPath.get(operation.path);
    const currentHash =
      currentContent === undefined ? null : packageFileHash(currentContent);

    if (operation.op === "upsert_file" && currentHash === null) {
      if (operation.baseHash !== null) {
        issues.push(`${operation.path}: expected existing file but it is new`);
      }
      continue;
    }

    if (operation.op === "delete_file" && currentHash === null) {
      issues.push(`${operation.path}: file no longer exists`);
      continue;
    }

    if (operation.baseHash !== currentHash) {
      issues.push(`${operation.path}: base hash does not match current file`);
    }
  }

  return issues;
}

function applyToVirtualFiles(
  currentFiles: readonly PackageArtifactFile[],
  action: FlowAssistantAction,
): PackageArtifactFile[] {
  const byPath = new Map(currentFiles.map((file) => [file.path, file.content]));

  for (const operation of action.operations) {
    if (operation.op === "delete_file") {
      byPath.delete(operation.path);
    } else {
      byPath.set(operation.path, operation.content);
    }
  }

  return Array.from(byPath.entries())
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function reject(args: {
  action: FlowAssistantAction;
  status: "invalid" | "stale" | "rejected";
  issues: readonly string[];
  message: string;
}): FlowAssistantActionValidation {
  return {
    ok: false,
    result: createRejectedActionResult({
      actionId: args.action.actionId,
      status: args.status,
      summary: args.action.summary,
      operations: args.action.operations,
      issues: args.issues,
      message: args.message,
    }),
  };
}
