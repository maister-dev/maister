import "server-only";

import type { SessionUser } from "@/lib/authz";
import type { RunKind, DelegationSnapshot } from "@/lib/db/schema";
import type { ResultStatus, RunResultContract } from "@/lib/run-results/types";
import type {
  RunPeekChildPage,
  RunPeekContent,
  RunPeekNode,
  RunPeekSnapshot,
  RunPeekSummary,
} from "@/lib/runs/peek-types";

import { eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  projectRolesForActions,
  requireActiveUserById,
  requireProjectRoleForUser,
} from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { runs, workspaces } from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { delegationTarget } from "@/lib/queries/run";
import { compileManifest } from "@/lib/flows/graph/compile";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { deriveResultStatus } from "@/lib/run-results/status";
import { parsePeekRunId } from "@/lib/runs/peek-http";
import { loadRunPublicResult } from "@/lib/runs/run-result-dto";
import { loadRunTerminalCause } from "@/lib/runs/terminal-cause";
import { findSharedTreeWorkspace } from "@/lib/runs/shared-tree";

const cursorSchema = z
  .object({
    version: z.literal(1),
    anchor: z.string().uuid(),
    parent: z.string().uuid(),
    launchedAt: z.string().datetime().nullable(),
    id: z.string().uuid(),
  })
  .strict();

type ChildCursor = z.infer<typeof cursorSchema>;
type PeekRun = Pick<
  typeof runs.$inferSelect,
  | "id"
  | "projectId"
  | "parentRunId"
  | "rootRunId"
  | "runKind"
  | "agentKind"
  | "currentStepId"
  | "workspaceMode"
  | "agentWorkspace"
  | "createdByUserId"
  | "localPackageId"
>;
export interface PeekRunAccess {
  run: PeekRun;
  user: SessionUser;
  canReadTranscript: boolean;
}
type ScopeRow = {
  id: string;
  projectId: string | null;
  parentRunId: string | null;
  depth: number;
  cycle: boolean;
};
type SummaryRow = {
  id: string;
  runKind: RunKind;
  status: string;
  startedAt: string | null;
  launchedAt: string | null;
  taskRef: string | null;
  taskTitle: string | null;
  displayName: string | null;
  hasChildren: boolean;
  delegationSnapshot: DelegationSnapshot | null;
  resultContract: RunResultContract | null;
  newestValidity: string | null;
  hasValid: boolean;
};

export function unavailablePeekRun(): MaisterError {
  return new MaisterError("PRECONDITION", "Run is unavailable", {
    details: { reason: "run_unavailable" },
  });
}

export async function authorizePeekRun(
  userId: string,
  runId: string,
): Promise<PeekRunAccess> {
  const user = await requireActiveUserById(userId);
  const [run] = await getDb()
    .select({
      id: runs.id,
      projectId: runs.projectId,
      parentRunId: runs.parentRunId,
      rootRunId: runs.rootRunId,
      runKind: runs.runKind,
      agentKind: runs.agentKind,
      currentStepId: runs.currentStepId,
      workspaceMode: runs.workspaceMode,
      agentWorkspace: runs.agentWorkspace,
      createdByUserId: runs.createdByUserId,
      localPackageId: runs.localPackageId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!run) throw unavailablePeekRun();
  if (!run.projectId) {
    if (
      run.createdByUserId !== userId ||
      run.runKind !== "scratch" ||
      !run.localPackageId
    )
      throw unavailablePeekRun();

    return { run, user, canReadTranscript: true };
  }
  try {
    const access = await requireProjectRoleForUser(
      userId,
      run.projectId,
      "viewer",
    );

    return {
      run,
      user,
      canReadTranscript: projectRolesForActions(["readRepoFiles"]).includes(
        access.role,
      ),
    };
  } catch (error) {
    if (isMaisterError(error) && error.code === "UNAUTHORIZED")
      throw unavailablePeekRun();
    throw error;
  }
}

/** Prove the complete path, including intermediate authorization, within 64 edges. */
export async function peekPath(
  userId: string,
  anchorId: string,
  selectedId: string,
): Promise<string[]> {
  await authorizePeekRun(userId, anchorId);
  await authorizePeekRun(userId, selectedId);
  const chain = await getDb().execute<ScopeRow>(sql`
    WITH RECURSIVE chain AS (
      SELECT id, project_id, parent_run_id, 0 AS depth, ARRAY[id] AS visited, false AS cycle
      FROM runs WHERE id=${selectedId}
      UNION ALL
      SELECT parent.id,parent.project_id,parent.parent_run_id,child.depth+1,
             child.visited || parent.id,parent.id=ANY(child.visited)
      FROM runs parent JOIN chain child ON parent.id=child.parent_run_id
      WHERE child.id<>${anchorId} AND child.depth<64 AND NOT child.cycle
    )
    SELECT id,project_id AS "projectId",parent_run_id AS "parentRunId",depth,cycle FROM chain ORDER BY depth`);
  const anchorIndex = chain.rows.findIndex((row) => row.id === anchorId);

  const path = (
    anchorIndex < 0 ? chain.rows : chain.rows.slice(0, anchorIndex + 1)
  ).toReversed();
  const authorizedProjects = new Set<string>();

  for (const row of path) {
    if (!row.projectId) {
      await authorizePeekRun(userId, row.id);
    } else if (!authorizedProjects.has(row.projectId)) {
      try {
        await requireProjectRoleForUser(userId, row.projectId, "viewer");
      } catch (error) {
        if (isMaisterError(error) && error.code === "UNAUTHORIZED")
          throw unavailablePeekRun();
        throw error;
      }
      authorizedProjects.add(row.projectId);
    }
  }

  if (anchorIndex < 0) {
    if (chain.rows.some((row) => row.cycle))
      throw new MaisterError("PRECONDITION", "Invalid Run hierarchy", {
        details: { reason: "hierarchy_invalid" },
      });
    if (chain.rows.at(-1)?.depth === 64 && chain.rows.at(-1)?.parentRunId)
      throw new MaisterError(
        "PRECONDITION",
        "Run hierarchy exceeds display depth",
        { details: { reason: "hierarchy_limit" } },
      );
    throw unavailablePeekRun();
  }

  return path.map((row) => row.id);
}

function resultState(row: SummaryRow): ResultStatus | null {
  if (!row.resultContract && !row.newestValidity) return null;

  return deriveResultStatus({
    runStatus: row.status,
    contract: row.resultContract,
    newestRow: row.newestValidity
      ? {
          id: "metadata",
          revision: 0,
          validity: row.newestValidity as
            "valid" | "stale" | "superseded" | "invalid",
          invalidReason: null,
        }
      : null,
    validRow: row.hasValid
      ? { id: "metadata", revision: 0, validity: "valid", invalidReason: null }
      : null,
  });
}

function summaryDto(row: SummaryRow): RunPeekSummary {
  const name = row.taskTitle ?? row.displayName;
  const identity = name
    ? `${row.taskRef ? `${row.taskRef} · ` : ""}${name}${row.taskRef ? "" : ` · ${row.id.slice(0, 8)}`}`
    : `${row.runKind} · ${row.id.slice(0, 8)}`;

  return {
    runId: row.id,
    label: identity,
    runKind: row.runKind,
    taskRef: row.taskRef,
    status: row.status,
    resultStatus: resultState(row),
    launchedAt: row.launchedAt,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
    hasChildren: row.hasChildren,
    delegationTarget: delegationTarget(row.delegationSnapshot),
    fullRunHref: `/runs/${row.id}`,
  };
}

function visibility(user: SessionUser, alias: "r" | "child"): SQL {
  const field = (name: string) => sql.raw(`${alias}.${name}`);

  return sql`(${user.role === "admin"} AND ${field("project_id")} IS NOT NULL OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=${field("project_id")} AND pm.user_id=${user.id}) OR ${field("project_id")} IS NULL AND ${field("run_kind")} = 'scratch' AND ${field("local_package_id")} IS NOT NULL AND ${field("created_by_user_id")}=${user.id})`;
}

function summaryColumns(user: SessionUser): SQL {
  return sql`r.id,r.run_kind AS "runKind",r.status,r.started_at AS "startedAt",to_char(r.launched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "launchedAt",
  CASE WHEN t.number IS NOT NULL THEN p.task_key || '-' || t.number::text ELSE NULL END AS "taskRef",
  t.title AS "taskTitle",COALESCE(r.agent_activity_snapshot->>'displayName',r.delegation_snapshot->>'agentDefinitionId',r.delegation_snapshot->>'flowRefId',r.delegation_snapshot->>'runnerId') AS "displayName",
  EXISTS(SELECT 1 FROM runs child WHERE child.parent_run_id=r.id AND ${visibility(user, "child")}) AS "hasChildren",
  r.delegation_snapshot AS "delegationSnapshot",r.result_contract AS "resultContract",
  (SELECT validity FROM run_results rr WHERE rr.run_id=r.id ORDER BY revision DESC LIMIT 1) AS "newestValidity",
  EXISTS(SELECT 1 FROM run_results rr WHERE rr.run_id=r.id AND rr.validity='valid') AS "hasValid"`;
}

export async function peekSummaries(
  user: SessionUser,
  ids: readonly string[],
): Promise<RunPeekSummary[]> {
  if (!ids.length) return [];
  const rows = await getDb().execute<SummaryRow>(
    sql`SELECT ${summaryColumns(user)} FROM runs r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN tasks t ON t.id=r.task_id WHERE r.id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`,
  );
  const byId = new Map(rows.rows.map((row) => [row.id, summaryDto(row)]));

  return ids.map((id) => {
    const summary = byId.get(id);

    if (!summary) throw unavailablePeekRun();

    return summary;
  });
}

function childCursor(raw: string, anchor: string, parent: string): ChildCursor {
  if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new MaisterError("CONFIG", "Invalid child cursor", {
      details: { reason: "invalid_cursor" },
    });
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (cause) {
    throw new MaisterError("CONFIG", "Invalid child cursor", {
      cause,
      details: { reason: "invalid_cursor" },
    });
  }
  const parsed = cursorSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data.anchor !== anchor ||
    parsed.data.parent !== parent
  )
    throw new MaisterError("CONFIG", "Child cursor scope does not match", {
      details: { reason: "invalid_cursor" },
    });

  return parsed.data;
}

export async function readRunPeekChildren(
  userId: string,
  anchorId: string,
  query: Record<string, string>,
): Promise<RunPeekChildPage> {
  const parentId =
    query.parent !== undefined ? parsePeekRunId(query.parent) : anchorId;
  const limit = query.limit === undefined ? 25 : Number(query.limit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new MaisterError("CONFIG", "Child page limit must be 1..50", {
      details: { reason: "invalid_limit" },
    });
  const cursor =
    query.cursor !== undefined
      ? childCursor(query.cursor, anchorId, parentId)
      : null;

  await peekPath(userId, anchorId, parentId);
  const user = await requireActiveUserById(userId);
  const visible = visibility(user, "r");
  const after = !cursor
    ? sql`true`
    : cursor.launchedAt === null
      ? sql`r.launched_at IS NULL AND r.id>${cursor.id}`
      : sql`(r.launched_at>${cursor.launchedAt}::timestamptz OR r.launched_at=${cursor.launchedAt}::timestamptz AND r.id>${cursor.id} OR r.launched_at IS NULL)`;
  const [rows, totals] = await Promise.all([
    getDb().execute<SummaryRow>(
      sql`SELECT ${summaryColumns(user)} FROM runs r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN tasks t ON t.id=r.task_id WHERE r.parent_run_id=${parentId} AND ${visible} AND (${after}) ORDER BY r.launched_at ASC NULLS LAST,r.id LIMIT ${limit + 1}`,
    ),
    getDb().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM runs r WHERE r.parent_run_id=${parentId} AND ${visible}`,
    ),
  ]);
  const items = rows.rows.slice(0, limit).map(summaryDto);
  const hasMore = rows.rows.length > limit;
  const last = items.at(-1);

  return {
    anchorRunId: anchorId,
    parentRunId: parentId,
    items,
    totalCount: totals.rows[0]?.count ?? 0,
    hasMore,
    nextCursor:
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              anchor: anchorId,
              parent: parentId,
              launchedAt: last.launchedAt,
              id: last.runId,
            } satisfies ChildCursor),
          ).toString("base64url")
        : null,
  };
}

async function flowContent(
  run: PeekRun,
  node: string | undefined,
): Promise<RunPeekContent> {
  const loaded = await loadRunManifest(run.id, getDb());

  if (!loaded || !loaded.compatible)
    return {
      kind: "flow",
      availability: "incompatible",
      compatible: false,
      incompatibility: loaded?.incompatibility ?? {
        kind: "invalid_manifest",
        message: "No pinned Flow graph is available",
      },
      nodes: [],
      selectedNodeId: null,
    };
  const graph = compileManifest(loaded.manifest);

  if (node !== undefined && !graph.nodes.has(node))
    throw new MaisterError("CONFIG", "Unknown Flow node", {
      details: { reason: "invalid_node" },
    });
  const attempts = await getDb().execute<{
    nodeId: string;
    attempt: number;
    status: string;
    failure: string | null;
    startedAt: string;
    endedAt: string | null;
  }>(
    sql`SELECT DISTINCT ON(node_id) node_id AS "nodeId",attempt,status,error_code AS failure,started_at AS "startedAt",ended_at AS "endedAt" FROM node_attempts WHERE run_id=${run.id} ORDER BY node_id,attempt DESC`,
  );
  const byId = new Map(
    attempts.rows.map((attempt) => [attempt.nodeId, attempt]),
  );
  const nodes: RunPeekNode[] = [...graph.nodes.values()].map((definition) => {
    const attempt = byId.get(definition.id);

    return {
      id: definition.id,
      label: definition.id,
      type: definition.nodeType,
      status: attempt?.status ?? "Pending",
      attempt: attempt?.attempt ?? null,
      failure: attempt?.failure ?? null,
      startedAt: attempt ? new Date(attempt.startedAt).toISOString() : null,
      endedAt: attempt?.endedAt
        ? new Date(attempt.endedAt).toISOString()
        : null,
    };
  });
  const selectedNodeId =
    node && graph.nodes.has(node)
      ? node
      : run.currentStepId && graph.nodes.has(run.currentStepId)
        ? run.currentStepId
        : (nodes[0]?.id ?? null);

  return {
    kind: "flow",
    availability: "ready",
    compatible: true,
    incompatibility: null,
    nodes,
    selectedNodeId,
  };
}

async function workspaceState(
  run: PeekRun,
): Promise<RunPeekSnapshot["workspace"]> {
  let [workspace] = await getDb()
    .select({ id: workspaces.id, removedAt: workspaces.removedAt })
    .from(workspaces)
    .where(eq(workspaces.runId, run.id))
    .limit(1);

  if (!workspace && run.workspaceMode === "shared" && run.rootRunId) {
    const shared = await findSharedTreeWorkspace(getDb(), run.rootRunId);

    if (shared)
      [workspace] = await getDb()
        .select({ id: workspaces.id, removedAt: workspaces.removedAt })
        .from(workspaces)
        .where(eq(workspaces.id, shared.id))
        .limit(1);
  }

  return !workspace ? "none" : workspace.removedAt ? "removed" : "present";
}

export async function readRunPeekSnapshot(
  userId: string,
  anchorId: string,
  query: Record<string, string>,
): Promise<RunPeekSnapshot> {
  const selectedId = parsePeekRunId(query.selected ?? "");

  if (selectedId === anchorId) throw unavailablePeekRun();
  const path = await peekPath(userId, anchorId, selectedId);
  const access = await authorizePeekRun(userId, selectedId);

  if (access.run.runKind !== "flow" && query.node !== undefined)
    throw new MaisterError("CONFIG", "This Run has no Flow nodes", {
      details: { reason: "invalid_node" },
    });
  const [breadcrumbs, publicResult, workspace, content] = await Promise.all([
    peekSummaries(access.user, path),
    loadRunPublicResult(getDb(), selectedId),
    workspaceState(access.run),
    access.run.runKind === "flow"
      ? flowContent(access.run, query.node)
      : Promise.resolve<RunPeekContent>({
          kind:
            access.run.agentKind === "operational"
              ? "operational"
              : "conversation",
          availability: access.canReadTranscript ? "ready" : "forbidden",
        }),
  ]);
  const summary = breadcrumbs.at(-1);

  if (!summary) throw unavailablePeekRun();

  return {
    anchorRunId: anchorId,
    selectedRunId: selectedId,
    breadcrumbs,
    summary,
    capabilities: {
      canReadTranscript: access.canReadTranscript,
      canReadEvidence: access.canReadTranscript,
    },
    workspace,
    content,
    publicResult,
    terminalCause: await loadRunTerminalCause(
      getDb(),
      selectedId,
      summary.status,
    ),
    fullRunHref: summary.fullRunHref,
  };
}
