import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { lstat, readlink, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { eq } from "drizzle-orm";

import { ensureWorktreeGitExclude } from "@/lib/capabilities/materialize";
import { flows, projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  flowCacheDirectory,
  flowIdSchema,
  flowRevisionSchema,
  projectFlowSymlinkPath,
  systemCachePath,
} from "@/lib/flow-paths";
import { ensureSymlink } from "@/lib/flows";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function unmanagedLink(): never {
  throw new MaisterError(
    "FLOW_INSTALL",
    "The project Flow link is occupied by an unmanaged filesystem entry.",
    { details: { reason: "project_flow_link_conflict" } },
  );
}
function isManagedTarget(ref: string, target: string): boolean {
  return (
    dirname(target) === flowCacheDirectory() &&
    basename(target).startsWith(ref + "@") &&
    /^(?:[a-f0-9]{12}|unknown)$/.test(basename(target).slice(ref.length + 1))
  );
}

async function managedDirectory(root: string, dir: string): Promise<boolean> {
  let current = root;

  for (const entry of relative(root, dir).split(sep)) {
    current = join(current, entry);
    try {
      if (!(await lstat(current)).isDirectory()) unmanagedLink();
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  return true;
}

/** Validate ownership before committing a candidate. Publish a link only from committed enablement. */
export async function validateProjectFlowLink({
  workspaceRoot,
  linkPath,
}: {
  workspaceRoot: string;
  linkPath: string;
}): Promise<void> {
  if (!(await managedDirectory(workspaceRoot, dirname(linkPath)))) return;
  try {
    if (!(await lstat(linkPath)).isSymbolicLink()) unmanagedLink();
    if (
      !isManagedTarget(
        basename(linkPath),
        resolve(dirname(linkPath), await readlink(linkPath)),
      )
    )
      unmanagedLink();
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export async function reconcileProjectFlowLinks(
  db: Db,
  target: { projectId: string; workspaceRoot?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({
        slug: projects.slug,
        repoPath: projects.repoPath,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(eq(projects.id, target.projectId))
      .for("update");

    if (!project || project.archivedAt) return;
    const workspaceRoot = target.workspaceRoot ?? project.repoPath;
    const directory = dirname(
      projectFlowSymlinkPath(workspaceRoot, project.slug, "member"),
    );
    const existing = (await managedDirectory(workspaceRoot, directory))
      ? await readdir(directory, { withFileTypes: true })
      : [];
    const rows = await tx
      .select({
        ref: flows.flowRefId,
        revision: flows.revision,
        path: flows.installedPath,
      })
      .from(flows)
      .where(eq(flows.projectId, target.projectId));
    const active = new Set(rows.map((row) => row.ref));

    for (const entry of existing) {
      if (
        !entry.isSymbolicLink() ||
        active.has(entry.name) ||
        !flowIdSchema.safeParse(entry.name).success
      )
        continue;
      const linkPath = join(directory, entry.name);

      if (
        isManagedTarget(
          entry.name,
          resolve(directory, await readlink(linkPath)),
        )
      )
        await unlink(linkPath);
    }
    const current = rows.filter(
      (row) =>
        flowRevisionSchema.safeParse(row.revision).success &&
        flowIdSchema.safeParse(row.ref).success &&
        row.path === systemCachePath(row.ref, row.revision),
    );

    if (current.length) await ensureWorktreeGitExclude(workspaceRoot);
    for (const row of current) {
      const linkPath = projectFlowSymlinkPath(
        workspaceRoot,
        project.slug,
        row.ref,
      );

      await validateProjectFlowLink({ workspaceRoot, linkPath });
      await ensureSymlink({ target: row.path, linkPath });
    }
  });
}
