import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";

type ProjectRouteRow = {
  id: string;
  archived_at: Date | string | null;
};

type RouteAuthDb = {
  execute(query: SQL): Promise<{ rows?: unknown[] }>;
};

export async function authorizeCatalogRouteProject(
  slug: string,
): Promise<{ projectId: string }> {
  await requireActiveSession();

  const db = getDb() as unknown as RouteAuthDb;
  const result = await db.execute(sql`
    SELECT id, archived_at
    FROM projects
    WHERE slug = ${slug}
    LIMIT 1
  `);
  const project = (result.rows ?? [])[0] as ProjectRouteRow | undefined;

  if (!project || project.archived_at) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  await requireProjectAction(project.id, "manageCatalog");

  return { projectId: project.id };
}
