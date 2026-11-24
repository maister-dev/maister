import "server-only";

import type { ContextRepoDecl } from "./types";
import type { Db } from "@/lib/execution-host/db";
import type { WorkspaceInputFile } from "@/lib/execution-host/workspace-inputs";
import type { WorkspaceContextInput } from "../../../runtime/workspace-context-input";

import { and, eq, isNull } from "drizzle-orm";

import { WORKSPACE_CONTEXT_INPUT } from "../../../runtime/workspace-context-input";

import { agentProjectLinks, projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { observeSelectedWorkspaceRevision } from "@/lib/execution-host/workspace-preparation";
import { contextMountEnabled } from "@/lib/instance-config";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";

type ContextDeclarations = Readonly<{
  stepId: string;
  repositories: readonly ContextRepoDecl[] | undefined;
}>;

/**
 * The Flow declaration selects names only. The launching user authorizes
 * each sibling before the selected host resolves its immutable Git revision.
 */
export async function captureAddressedFlowContexts(
  db: Db,
  declarations: readonly ContextDeclarations[],
  userId: string | null | undefined,
): Promise<readonly WorkspaceInputFile[]> {
  if (!contextMountEnabled()) return [];

  return captureAddressedContexts(
    db,
    declarations,
    async (projectId, projectSlug) => {
      if (!userId)
        throw new MaisterError(
          "UNAUTHORIZED",
          "Addressed Flow context requires a launching user's repository grant",
          {
            details: {
              reason: "workspace_context_authority_required",
              projectSlug,
            },
          },
        );
      await assertTaskLaunchUserAuthority(db, projectId, userId, [
        "readRepoFiles",
      ]);
    },
  );
}

/** The active project attachment preserves the administrator's sibling consent. */
export async function captureAddressedAgentContexts(
  db: Db,
  projectId: string,
  agentId: string,
): Promise<readonly WorkspaceInputFile[]> {
  if (!contextMountEnabled()) return [];
  const [link] = await db
    .select({ contextRepos: agentProjectLinks.contextRepos })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, agentId),
        eq(agentProjectLinks.projectId, projectId),
        eq(agentProjectLinks.enabled, true),
      ),
    );
  if (!link?.contextRepos?.length) return [];

  return captureAddressedContexts(
    db,
    [{ stepId: "agent", repositories: link.contextRepos }],
    async () => {},
  );
}

async function captureAddressedContexts(
  db: Db,
  declarations: readonly ContextDeclarations[],
  authorize: (projectId: string, projectSlug: string) => Promise<void>,
): Promise<readonly WorkspaceInputFile[]> {
  const captured: WorkspaceContextInput[] = [];

  for (const { stepId, repositories } of declarations) {
    for (const repository of repositories ?? []) {
      const [project] = await db
        .select({ id: projects.id, mainBranch: projects.mainBranch })
        .from(projects)
        .where(
          and(
            eq(projects.slug, repository.project),
            isNull(projects.archivedAt),
          ),
        );
      if (!project)
        throw new MaisterError(
          "PRECONDITION",
          "Addressed Flow context repository is unavailable",
          {
            details: {
              reason: "workspace_context_unavailable",
              projectSlug: repository.project,
            },
          },
        );

      await authorize(project.id, repository.project);
      const ref = repository.ref ?? project.mainBranch;
      if (!ref)
        throw new MaisterError(
          "PRECONDITION",
          "Addressed Flow context requires an approved branch",
          {
            details: {
              reason: "source_ref_unapproved",
              projectSlug: repository.project,
            },
          },
        );
      const commit = await observeSelectedWorkspaceRevision(project.id, ref);
      captured.push({
        stepId,
        repositoryId: project.id,
        slug: repository.project,
        ref,
        commit,
        declaredRef: repository.ref ?? null,
      });
    }
  }
  if (captured.length === 0) return [];

  return [
    {
      path: WORKSPACE_CONTEXT_INPUT,
      bytes: Buffer.from(JSON.stringify(captured)),
    },
  ];
}
