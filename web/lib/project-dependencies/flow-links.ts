import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { lstat, readlink, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { ensureWorktreeGitExclude } from "@/lib/capabilities/materialize";
import {
  flows,
  projects,
  projectFlowLinkPublications as publications,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  flowCacheDirectory,
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

const log = pino({ name: "project-flow-link-publication" });
type Publication = typeof publications.$inferSelect;

/** Persist immutable scope alongside the native decision. The worker always projects
 * the latest committed row, even if a newer attach has superseded this operation. */
export async function queueProjectFlowLinks(
  tx: Db,
  operationId: string,
  projectId: string,
  workspaceRoot: string,
  refs: readonly string[],
): Promise<void> {
  if (!refs.length) return;
  await tx
    .insert(publications)
    .values(
      [...new Set(refs)].map((flowRefId) => ({
        operationId,
        projectId,
        workspaceRoot,
        flowRefId,
      })),
    )
    .onConflictDoNothing();
}

async function applyLink(
  tx: Db,
  job: Publication,
  slug: string,
): Promise<void> {
  const { projectId, flowRefId, workspaceRoot } = job;
  const [flow] = await tx
    .select({ revision: flows.revision, path: flows.installedPath })
    .from(flows)
    .where(and(eq(flows.projectId, projectId), eq(flows.flowRefId, flowRefId)));
  const linkPath = projectFlowSymlinkPath(workspaceRoot, slug, flowRefId);
  if (flow) {
    if (
      !flowRevisionSchema.safeParse(flow.revision).success ||
      flow.path !== systemCachePath(flowRefId, flow.revision)
    )
      return;
    await validateProjectFlowLink({ workspaceRoot, linkPath });
    await ensureWorktreeGitExclude(workspaceRoot);
    await ensureSymlink({ target: flow.path, linkPath });
    return;
  }
  if (!(await managedDirectory(workspaceRoot, dirname(linkPath)))) return;
  try {
    if (
      (await lstat(linkPath)).isSymbolicLink() &&
      isManagedTarget(
        flowRefId,
        resolve(dirname(linkPath), await readlink(linkPath)),
      )
    )
      await unlink(linkPath);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

type LinkResult = "idle" | "published" | "deferred";
type LinkKey = Pick<Publication, "operationId" | "flowRefId">;
async function publishOne(db: Db, key?: LinkKey): Promise<LinkResult> {
  return db.transaction(async (tx) => {
    const scope = key
      ? and(
          eq(publications.operationId, key.operationId),
          eq(publications.flowRefId, key.flowRefId),
        )
      : sql`${publications.dueAt}<=clock_timestamp()`;
    const query = tx
      .select({ job: publications, slug: projects.slug })
      .from(projects)
      .innerJoin(publications, eq(publications.projectId, projects.id))
      .where(and(scope, sql`${projects.archivedAt} IS NULL`))
      .orderBy(
        publications.dueAt,
        publications.operationId,
        publications.flowRefId,
      )
      .limit(1);
    // Immediate callers wait for a concurrent reconciler's decision; the background scan skips busy projects.
    const [selected] = key
      ? await query.for("update")
      : await query.for("update", { skipLocked: true });
    if (!selected) return "idle";
    const { job, slug } = selected;
    const exact = and(
      eq(publications.operationId, job.operationId),
      eq(publications.flowRefId, job.flowRefId),
    );
    try {
      await applyLink(tx, job, slug);
    } catch (error) {
      const reason =
        error instanceof MaisterError &&
        error.details?.reason === "project_flow_link_conflict"
          ? "project_flow_link_conflict"
          : "project_flow_link_unavailable";
      await tx
        .update(publications)
        .set({ reason, dueAt: sql`clock_timestamp()+interval '30 seconds'` })
        .where(exact);
      log.warn(
        { projectId: job.projectId, flowRefId: job.flowRefId, reason },
        "committed Flow link awaits repair",
      );
      return "deferred";
    }
    await tx.delete(publications).where(exact);
    return "published";
  });
}

export async function serviceFlowLinkPublication(db: Db): Promise<boolean> {
  return (await publishOne(db)) !== "idle";
}

/** A failed filesystem projection leaves a durable job. Distinguish the accepted
 * database mutation from an installation that was rejected before commit. */
export type PendingFlowLink = {
  reason: "project_flow_link_pending";
  operationId: string;
  memberRef: string;
  linkReason: string | null;
};

export function readAcceptedFlowLink(error: unknown): {
  flowLinkPending: PendingFlowLink;
  attachmentId?: string;
} | null {
  if (!(error instanceof MaisterError) || error.code !== "PRECONDITION")
    return null;
  const details = error.details;
  if (
    details?.reason !== "project_flow_link_pending" ||
    details.mutationAccepted !== true ||
    typeof details.operationId !== "string" ||
    typeof details.memberRef !== "string" ||
    !(details.linkReason === null || typeof details.linkReason === "string")
  )
    return null;
  return {
    ...(typeof details.attachmentId === "string"
      ? { attachmentId: details.attachmentId }
      : {}),
    flowLinkPending: {
      reason: details.reason,
      operationId: details.operationId,
      memberRef: details.memberRef,
      linkReason: details.linkReason,
    },
  };
}

export async function finishFlowLinkPublication(
  db: Db,
  operationId: string,
  attachmentId?: string,
): Promise<void> {
  const jobs = await db
    .select({
      operationId: publications.operationId,
      flowRefId: publications.flowRefId,
    })
    .from(publications)
    .where(eq(publications.operationId, operationId));
  if (!jobs.length) return;
  for (const job of jobs) await publishOne(db, job);
  const [pending] = await db
    .select({ ref: publications.flowRefId, reason: publications.reason })
    .from(publications)
    .where(eq(publications.operationId, operationId))
    .limit(1);
  if (pending)
    throw new MaisterError(
      "PRECONDITION",
      "The installation change was committed. Its project Flow link is awaiting repair.",
      {
        details: {
          reason: "project_flow_link_pending",
          mutationAccepted: true,
          operationId,
          ...(attachmentId ? { attachmentId } : {}),
          memberRef: pending.ref,
          linkReason: pending.reason,
        },
      },
    );
}
