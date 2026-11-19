import "server-only";

import type { Vault, VaultAccess } from "./store";
import type { MemoryLink } from "./structure";
import type { Db } from "@/lib/execution-host/db";

import { sql } from "drizzle-orm";

import { readKnowledgeRecord } from "@/lib/brain/knowledge-records";
import { isMaisterError } from "@/lib/errors";

type ProjectLinkContext = Readonly<{
  id: string;
  slug: string;
  task_key: string | null;
  repo_url: string | null;
  main_branch: string;
}>;

async function projectContext(tx: Db, vault: Vault) {
  if (!vault.projectId) return undefined;
  const result = await tx.execute<ProjectLinkContext>(sql`
    SELECT id,slug,task_key,repo_url,main_branch FROM projects WHERE id=${vault.projectId}
  `);

  return result.rows[0];
}

function repoHref(project: ProjectLinkContext, link: MemoryLink) {
  const entered = project.repo_url ? URL.parse(project.repo_url) : null;
  if (
    !entered ||
    entered.protocol !== "https:" ||
    entered.username ||
    entered.password ||
    !link.fragment
  )
    return null;
  const route =
    entered.hostname === "github.com"
      ? "blob"
      : entered.hostname === "gitlab.com"
        ? "-/blob"
        : null;
  if (!route) return null;
  const branch = encodeURIComponent(project.main_branch);
  const path = link.target.split("/").map(encodeURIComponent).join("/");
  const repo = entered.pathname.replace(/\/$/, "").replace(/\.git$/, "");

  return `${entered.origin}${repo}/${route}/${branch}/${path}#L${link.fragment}`;
}

function sameProjectTaskNumber(project: ProjectLinkContext, target: string) {
  const parts = /^(.+)-([1-9][0-9]*)$/.exec(target);
  if (!parts || project.task_key !== parts[1]) return null;
  const value = Number(parts[2]);

  return value <= 2147483647 ? value : null;
}

export async function makeMemoryEntityResolver(
  tx: Db,
  access: VaultAccess,
  vault: Vault,
) {
  const project =
    access.actor.kind === "human" ? await projectContext(tx, vault) : undefined;
  const userId = access.actor.kind === "human" ? access.actor.userId : null;

  return async (link: MemoryLink): Promise<string | null> => {
    if (!project || !userId) return null;
    if (link.kind === "task") {
      const number = sameProjectTaskNumber(project, link.target);
      if (number === null) return null;
      const result = await tx.execute(
        sql`SELECT 1 FROM tasks WHERE project_id=${project.id} AND number=${number}`,
      );

      return result.rows.length
        ? `/projects/${encodeURIComponent(project.slug)}/tasks/${number}`
        : null;
    }
    if (link.kind === "run") {
      const result = await tx.execute(
        sql`SELECT 1 FROM runs WHERE project_id=${project.id} AND id=${link.target}`,
      );

      return result.rows.length
        ? `/runs/${encodeURIComponent(link.target)}`
        : null;
    }
    if (link.kind === "repo") return repoHref(project, link);
    if (link.kind !== "brain" && link.kind !== "knowledge") return null;
    const { rows } = await tx.execute<{ ready: boolean }>(
      sql`SELECT to_regclass('brain_items') IS NOT NULL AS ready`,
    );
    if (rows[0]?.ready !== true) return null;

    try {
      const revision =
        link.fragment === null ? undefined : Number(link.fragment);
      await readKnowledgeRecord(
        tx,
        { kind: "user", userId },
        { recordId: link.target, revision },
      );

      return `/knowledge/${encodeURIComponent(link.target)}${revision === undefined ? "" : `?revision=${revision}`}`;
    } catch (error) {
      if (
        isMaisterError(error) &&
        (error.code === "PRECONDITION" ||
          error.code === "UNAUTHORIZED" ||
          error.code === "CONFIG")
      )
        return null;
      throw error;
    }
  };
}
