import "server-only";

import type { InstallationAgentScope } from "./installation-access-types";
import type { InstallationRunAuthority } from "./installation-authority";
import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  installationProjectAccess,
  requireInstallationCredential,
} from "./installation-authority";
import { captureInstallationProjects } from "./installation-source-capture";

import { privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import type { TokenActor } from "@/lib/tokens/verify";
import { MaisterError } from "@/lib/errors";
import { parseCursorPayload, signCursorPayload } from "@/lib/keyset-cursor";

const resources = z.enum([
  "projects",
  "tasks",
  "runs",
  "activity",
  "observatory",
]);
export type InstallationResource = z.infer<typeof resources>;
export const installationResourceScope = {
  projects: "projects:read",
  tasks: "tasks:read",
  runs: "runs:read",
  activity: "activity:read",
  observatory: "observatory:read",
} as const satisfies Record<InstallationResource, InstallationAgentScope>;
const identity = z
  .string()
  .min(1)
  .max(192)
  .refine((value) => value.isWellFormed() && !value.includes("\0"));
const selection = z.strictObject({
  slug: identity.optional(),
  id: identity.optional(),
  runId: identity.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number)
    .pipe(z.number().max(50))
    .prefault("20"),
  period: z.enum(["24h", "7d", "30d"]).default("7d"),
});
const cursorSchema = z.strictObject({
  scope: z.string().length(64),
  after: identity,
});
const namespace = "maister.installation.read.v1";
const intervals = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };
type Query = z.infer<typeof selection>;
type Row = { id: string; projectId: string; slug: string };

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
  after?: string,
) {
  return tx.execute<Row>(sql`
    WITH allowed_projects AS MATERIALIZED (
      SELECT p.id,p.slug,p.name,p.task_key FROM projects p
      WHERE p.archived_at IS NULL AND ${installationProjectAccess(context, sql`p.id`, resource === "activity" ? "readRepoFiles" : "readBoard")}
        ${query.slug ? sql`AND p.slug=${query.slug}` : sql``}
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
) {
  const input = Object.fromEntries(params);
  const validated = selection.safeParse(input);
  if (
    !validated.success ||
    params.size !== Object.keys(input).length ||
    (resource === "observatory" ? params.has("id") : params.has("period")) ||
    (resource !== "activity" && params.has("runId"))
  )
    throw new MaisterError("CONFIG", "Invalid installation read selection");
  const { cursor, ...query } = validated.data;
  return db.transaction(async (tx) => {
    const context = await requireInstallationCredential(
      tx,
      tokenId,
      installationResourceScope[resource],
    );
    const scope = createHash("sha256")
      .update(JSON.stringify([context.runId, resource, query]))
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
    const { rows } = await selectInstallationRows(
      tx,
      context,
      resource,
      query,
      after?.success ? after.data.after : undefined,
    );
    const page = rows.slice(0, query.limit);

    await captureInstallationProjects(
      tx,
      context.runId,
      rows.map(({ projectId }) => projectId),
    );
    const last = page.at(-1);

    return {
      items:
        resource === "observatory" ? page.map(({ id, ...row }) => row) : page,
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
  target: Readonly<{ slug?: string; id?: string; runId?: string }> = {},
) {
  return {
    scope: installationResourceScope[resource],
    async work(actor: TokenActor) {
      const params = new URL(request.url).searchParams;
      for (const [key, value] of Object.entries(target)) {
        if (params.has(key))
          throw new MaisterError(
            "CONFIG",
            "The resource identifier comes from the route",
          );
        params.set(key, value);
      }
      const page = await readInstallationResource(
        getDb(),
        actor.tokenId,
        resource,
        params,
      );
      if (target.id || (target.slug && resource === "projects")) {
        if (!page.items[0])
          throw new MaisterError("PRECONDITION", "Resource unavailable", {
            details: { reason: "installation_resource_unavailable" },
          });

        return privateJson(page.items[0]);
      }

      return privateJson(page);
    },
  };
}
