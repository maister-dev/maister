import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { listSourceInstallsForLocalPackages } from "@/lib/local-packages/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/queries/packages.ts).
const { localPackages } = schemaModule as unknown as Record<string, any>;

export type ProjectLocalPackageOrigin =
  | { kind: "forked"; packageName: string; versionLabel: string }
  | { kind: "local" };

export type ProjectLocalPackageView = {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
  origin: ProjectLocalPackageOrigin;
};

// Project-owned local packages (the per-project default + project forks),
// active only, newest first. Surfaced as rows on the project Packages tab; the
// working-dir contents live in the Studio editor (no BOM compiler here).
export async function getProjectLocalPackages(
  projectId: string,
): Promise<ProjectLocalPackageView[]> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(localPackages)
    .where(
      and(
        eq(localPackages.projectId, projectId),
        eq(localPackages.status, "active"),
      ),
    )
    .orderBy(desc(localPackages.updatedAt));

  const sourceInstalls = await listSourceInstallsForLocalPackages(rows);

  return rows.map((row: any): ProjectLocalPackageView => {
    const source = row.sourceInstallId
      ? sourceInstalls.get(row.sourceInstallId)
      : undefined;

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isDefault: row.isDefault,
      origin: source
        ? {
            kind: "forked",
            packageName: source.name,
            versionLabel: source.versionLabel,
          }
        : { kind: "local" },
    };
  });
}
