import "server-only";

import type { WorkspaceReconciliationFindingState } from "@/lib/db/schema";

import { and, asc, eq, gt, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const { workspaceReconciliationFindings } = schema;

const FINDING_STATES = [
  "observed",
  "held",
  "retry_waiting",
  "failed",
  "quarantined",
  "resolved",
] as const satisfies readonly WorkspaceReconciliationFindingState[];

export type WorkspaceReconciliationFindingPageItem = {
  id: string;
  candidateKind: string;
  state: WorkspaceReconciliationFindingState;
  relativePath: string;
  projectId: string | null;
  runId: string | null;
  workspaceId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  nextRetryAt: Date | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  resultCode: string | null;
  rescueRef: string | null;
  resolvedAt: Date | null;
};

export type WorkspaceReconciliationFindingPage = {
  findings: WorkspaceReconciliationFindingPageItem[];
  nextCursor: string | null;
};

export function isWorkspaceReconciliationFindingState(
  value: string | null,
): value is WorkspaceReconciliationFindingState {
  return (
    value !== null &&
    FINDING_STATES.includes(value as WorkspaceReconciliationFindingState)
  );
}

function decodeCursor(cursor: string): string {
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");

    if (!/^wrf_[a-f0-9]{40}$/u.test(id)) {
      throw new Error("invalid finding cursor");
    }

    return id;
  } catch {
    throw new MaisterError("CONFIG", "invalid workspace reconciliation cursor");
  }
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export async function listWorkspaceReconciliationFindings(args: {
  state?: WorkspaceReconciliationFindingState;
  cursor?: string;
  limit: number;
}): Promise<WorkspaceReconciliationFindingPage> {
  const cursorId = args.cursor ? decodeCursor(args.cursor) : null;
  const conditions: SQL[] = [];

  if (args.state) {
    conditions.push(eq(workspaceReconciliationFindings.state, args.state));
  }
  if (cursorId) {
    conditions.push(gt(workspaceReconciliationFindings.id, cursorId));
  }

  const rows = await getDb()
    .select({
      id: workspaceReconciliationFindings.id,
      candidateKind: workspaceReconciliationFindings.candidateKind,
      state: workspaceReconciliationFindings.state,
      relativePath: workspaceReconciliationFindings.relativePath,
      projectId: workspaceReconciliationFindings.projectId,
      runId: workspaceReconciliationFindings.runId,
      workspaceId: workspaceReconciliationFindings.workspaceId,
      firstSeenAt: workspaceReconciliationFindings.firstSeenAt,
      lastSeenAt: workspaceReconciliationFindings.lastSeenAt,
      nextRetryAt: workspaceReconciliationFindings.nextRetryAt,
      attemptCount: workspaceReconciliationFindings.attemptCount,
      lastErrorCode: workspaceReconciliationFindings.lastErrorCode,
      lastErrorMessage: workspaceReconciliationFindings.lastErrorMessage,
      resultCode: workspaceReconciliationFindings.resultCode,
      rescueRef: workspaceReconciliationFindings.rescueRef,
      resolvedAt: workspaceReconciliationFindings.resolvedAt,
    })
    .from(workspaceReconciliationFindings)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(workspaceReconciliationFindings.id))
    .limit(args.limit + 1);
  const hasNextPage = rows.length > args.limit;
  const findings = rows.slice(0, args.limit);
  const last = findings.at(-1);

  return {
    findings,
    nextCursor: hasNextPage && last ? encodeCursor(last.id) : null,
  };
}
