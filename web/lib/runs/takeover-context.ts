import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// M11b (ADR-030): the return route resolves the merge-base against the
// project's default branch. `loadRun` returns only the project slug, so the
// `main_branch` is read here. Server-state only — never a body field.
export async function loadProjectMainBranch(
  projectId: string,
  db?: Db,
): Promise<string> {
  const d = db ?? getDb();
  const rows: Array<{ mainBranch: string }> = await d
    .select({ mainBranch: projects.mainBranch })
    .from(projects)
    .where(eq(projects.id, projectId));

  const mainBranch = rows[0]?.mainBranch;

  if (!mainBranch) {
    throw new MaisterError(
      "PRECONDITION",
      `project ${projectId} not found or has no main branch`,
    );
  }

  return mainBranch;
}
