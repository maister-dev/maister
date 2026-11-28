import "server-only";

import type { InstallationAgentScope } from "./installation-access-types";
import type { InstallationRunAuthority } from "./installation-authority";
import type { Db } from "@/lib/execution-host/db";
import type { TokenActor } from "@/lib/tokens/verify";

import { getTaskDisplayStatuses, requireTaskDisplayStatus } from "@/lib/tasks/task-display-status-queries";
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";
import { z } from "zod";

import {
  installationProjectAccess,
  requireInstallationCredential,
} from "./installation-authority";
import { captureInstallationProjects } from "./installation-source-capture";

import { privateJson } from "@/lib/api/private-json";
import { recordNativeRunSourcesInTransaction } from "@/lib/brain/knowledge-execution-access";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

export const installationResourceScope = {
  projects: "projects:read",
  tasks: "tasks:read",
  runs: "runs:read",
  activity: "activity:read",
  observatory: "observatory:read",
} as const satisfies Record<string, InstallationAgentScope>;
export type InstallationResource = keyof typeof installationResourceScope;
const log = pino({
  name: "installation-read",
  level: process.env.LOG_LEVEL ?? "info",
});
const identity = z
  .string()
  .min(1)
  .max(192)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));
const pathTarget = z.strictObject({
  slug: identity.optional(),
  id: identity.optional(),
  runId: identity.optional(),
});
const paging = z.strictObject({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number)
    .pipe(z.number().max(50))
    .prefault("20"),
});
const observatoryQuery = paging.extend({
  slug: identity.optional(),
  period: z.enum(["24h", "7d", "30d"]).default("7d"),
});
const noQuery = z.strictObject({});
const cursorSchema = z.strictObject({
  scope: z.string().length(64),
  after: identity,
});
const namespace = "maister.installation.read.v1";
const intervals = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

type PathTarget = Readonly<z.infer<typeof pathTarget>>;
type Query = z.infer<typeof observatoryQuery> & PathTarget;
type Row = { id: string; projectId: string; slug: string };

function isDetail(resource: InstallationResource, target: PathTarget) {
  return (
    target.id !== undefined ||
    (resource === "projects" && target.slug !== undefined)
  );
}

function unavailableResource() {
  return new MaisterError("PRECONDITION", "Resource unavailable", {
    details: { reason: "installation_resource_unavailable" },
  });
}

function accessibleProject(
  context: InstallationRunAuthority,
  resource: InstallationResource,
) {
  return sql`p.archived_at IS NULL AND ${installationProjectAccess(
    context,
    sql`p.id`,
    resource === "activity" ? "readRepoFiles" : "readBoard",
  )}`;
}

async function resolveCollectionProject(
  tx: Db,
  context: InstallationRunAuthority,
  resource: InstallationResource,
  target: PathTarget,
): Promise<string | null> {
  const restriction =
    resource === "tasks" && target.id === undefined
      ? sql`p.slug=${target.slug}`
      : resource === "activity"
        ? sql`EXISTS (SELECT 1 FROM runs r WHERE r.id=${target.runId} AND r.project_id=p.id FOR SHARE)`
        : null;

  if (restriction === null) return null;
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT p.id FROM projects p
    WHERE ${restriction} AND ${accessibleProject(context, resource)}
    FOR SHARE OF p
  `);

  if (!rows[0]) throw unavailableResource();

  return rows[0].id;
}

function relatedRows(resource: InstallationResource, query: Query) {
  switch (resource) {
    case "projects":
      return sql`SELECT p.id,p.id AS "projectId",p.slug,p.name
        FROM allowed_projects p`;
    case "tasks":
      return sql`SELECT t.id,p.id AS "projectId",p.slug,t.number,t.title,t.status
        FROM tasks t JOIN allowed_projects p ON p.id=t.project_id`;
    case "runs":
      return sql`SELECT r.id,p.id AS "projectId",p.slug,r.status,r.run_kind AS "runKind",r.task_id AS "taskId",
        r.started_at AS "startedAt",r.ended_at AS "endedAt" FROM runs r JOIN allowed_projects p ON p.id=r.project_id`;
    case "activity":
      return sql`SELECT event.id,p.id AS "projectId",p.slug,r.id AS "runId",event.event_type AS "type",event.occurred_at AS "occurredAt"
        FROM execution_events event JOIN runs r ON r.id=event.run_id JOIN allowed_projects p ON p.id=r.project_id
        ${query.runId ? sql`WHERE r.id=${query.runId}` : sql``}`;
    case "observatory":
      return sql`SELECT p.id,p.id AS "projectId",p.slug,count(r.id)::int AS "runCount",
        count(r.id) FILTER (WHERE r.status='Done')::int AS "successCount",
        coalesce(sum(greatest(extract(epoch from (r.ended_at-r.started_at)) * 1000,0)),0)::float8 AS "durationMs"
        FROM allowed_projects p JOIN runs r ON p.id=r.project_id
          AND r.started_at >= transaction_timestamp()-${intervals[query.period]}::interval
        GROUP BY p.id,p.slug`;
  }
}

async function selectInstallationRows(
  tx: Db,
  context: InstallationRunAuthority,
  resource: InstallationResource,
  query: Query,
  collectionProjectId: string | null,
  after?: string,
) {
  return tx.execute<Row>(sql`
    WITH allowed_projects AS MATERIALIZED (
      SELECT p.id,p.slug,p.name FROM projects p
      WHERE ${accessibleProject(context, resource)}
        ${query.slug ? sql`AND p.slug=${query.slug}` : sql``}
        ${collectionProjectId === null ? sql`` : sql`AND p.id=${collectionProjectId}`}
      FOR SHARE OF p
    ), rows AS (${relatedRows(resource, query)})
    SELECT * FROM rows WHERE ${query.id ? sql`rows.id=${query.id}` : sql`true`}
      ${after ? sql`AND rows.id COLLATE "C">${after}` : sql``}
    ORDER BY rows.id COLLATE "C" LIMIT ${query.limit + 1}
  `);
}

export async function readInstallationResource(
  db: Db,
  tokenId: string,
  resource: InstallationResource,
  params: URLSearchParams,
  target: PathTarget = {},
) {
  const detail = isDetail(resource, target);
  const input = Object.fromEntries(params);
  const parsed = (
    resource === "observatory" ? observatoryQuery : detail ? noQuery : paging
  ).safeParse(input);
  const routeTarget = pathTarget.safeParse(target);

  if (
    !parsed.success ||
    !routeTarget.success ||
    params.size !== Object.keys(input).length ||
    (resource === "tasks" && target.slug === undefined) ||
    (resource === "activity" && target.runId === undefined)
  )
    throw new MaisterError("CONFIG", "Invalid installation read selection");
  const { cursor, ...query }: Query & { cursor?: string } = {
    limit: detail ? 1 : 20,
    period: "7d",
    ...parsed.data,
    ...routeTarget.data,
  };

  return db.transaction(async (tx) => {
    const context = await requireInstallationCredential(
      tx,
      tokenId,
      installationResourceScope[resource],
    );
    // Preserve the v1 field order for cursors issued before query validation was split.
    const { slug, id, runId, limit, period } = query;
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          context.runId,
          resource,
          { slug, id, runId, limit, period },
        ]),
      )
      .digest("hex");
    const after =
      cursor === undefined
        ? null
        : cursorSchema.safeParse(parseCursorPayload(namespace, cursor));

    if (after && (!after.success || after.data.scope !== scope))
      throw new MaisterError(
        "CONFIG",
        "Installation cursor belongs to another selection",
      );
    const collectionProjectId = await resolveCollectionProject(
      tx,
      context,
      resource,
      routeTarget.data,
    );
    const { rows } = await selectInstallationRows(
      tx,
      context,
      resource,
      query,
      collectionProjectId,
      after?.success ? after.data.after : undefined,
    );
    const page = rows.slice(0, query.limit);

    if (detail && page.length === 0) throw unavailableResource();
    const projectIds = new Set([
      ...(collectionProjectId === null ? [] : [collectionProjectId]),
      ...page.map(({ projectId }) => projectId),
    ]);

    if (resource === "activity") {
      // Preserve the readRepoFiles gate for later consumers of this activity.
      await recordNativeRunSourcesInTransaction(
        tx,
        context.runId,
        [...projectIds].map((projectId) => ({
          kind: "project_context",
          projectId,
        })),
      );
    } else {
      await captureInstallationProjects(tx, context.runId, [...projectIds]);
    }
    const last = page.at(-1);
    const statuses = resource === "tasks"
      ? await getTaskDisplayStatuses(page.map(({ id }) => id), tx)
      : null;

    log.debug(
      {
        runId: context.runId,
        resource,
        items: page.length,
        more: rows.length > query.limit,
      },
      "[FIX] served a scoped installation read",
    );

    return {
      items:
        resource === "observatory"
          ? page.map(({ id: _id, ...row }) => row)
          : statuses
            ? page.map((row) => ({ ...row, displayStatus: requireTaskDisplayStatus(statuses, row.id) }))
            : page,
      nextCursor:
        last && rows.length > query.limit
          ? signCursorPayload(namespace, { scope, after: last.id })
          : null,
    };
  });
}

export function installationReadAdapter(
  request: Request,
  resource: InstallationResource,
  target: PathTarget = {},
) {
  return {
    scope: installationResourceScope[resource],
    async work(actor: TokenActor) {
      const page = await readInstallationResource(
        getDb(),
        actor.tokenId,
        resource,
        new URL(request.url).searchParams,
        target,
      );

      return privateJson(isDetail(resource, target) ? page.items[0] : page);
    },
  };
}
