import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { AgentActivitySummary } from "@/lib/agents/activity-queries";

import { and, desc, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import {
  agentProjectLinks,
  agents,
  projects,
  runs,
  agentTriggerAttempts,
  agentIncidentEpisodes,
} from "@/lib/db/schema";
import { getDb } from "@/lib/db/client";
import {
  requireActiveSession,
  requireProjectRoleForUser,
  projectRolesForActions,
  type SessionUser,
} from "@/lib/authz";
import { decodeRouteParam } from "@/lib/route-params";
import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getAgentActivitySummaries } from "@/lib/agents/activity-queries";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { resolveAgentConfig } from "@/lib/agents/config";
import { buildAgentActivitySnapshot } from "@/lib/agents/activity-snapshot";

export type AgentActivityAccess = {
  db: Db;
  actor: SessionUser;
  projectId: string;
  agentId: string;
  displayName: string;
  attachmentState: "attached" | "detached" | "deleted";
  canReadDefinition: boolean;
  canEditSettings: boolean;
  canRetry: boolean;
};

/** Membership is checked before consulting any agent association or retained evidence. */
export async function resolveAgentActivityAccess(
  slug: string,
  rawAgentId: string,
): Promise<AgentActivityAccess> {
  const actor = await requireActiveSession();
  const agentId = decodeRouteParam(rawAgentId, "agentId");
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!project || project.archivedAt)
    throw new MaisterError("PRECONDITION", "Project is unavailable", {
      details: { reason: "activity_not_found" },
    });
  const access = await requireProjectRoleForUser(
    actor.id,
    project.id,
    "viewer",
  );
  const [link, catalog, history, attempts, incidents] = await Promise.all([
    db
      .select({ id: agentProjectLinks.id, enabled: agentProjectLinks.enabled })
      .from(agentProjectLinks)
      .where(
        and(
          eq(agentProjectLinks.projectId, project.id),
          eq(agentProjectLinks.agentId, agentId),
        ),
      )
      .limit(1),
    db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1),
    db
      .select({
        name: sql<string | null>`${runs.agentActivitySnapshot}->>'displayName'`,
      })
      .from(runs)
      .where(
        and(eq(runs.projectId, project.id), eq(runs.sourceAgentId, agentId)),
      )
      .orderBy(desc(runs.activitySortAt), desc(runs.id))
      .limit(1),
    db
      .select({ id: agentTriggerAttempts.id })
      .from(agentTriggerAttempts)
      .where(
        and(
          eq(agentTriggerAttempts.projectId, project.id),
          eq(agentTriggerAttempts.sourceAgentId, agentId),
        ),
      )
      .limit(1),
    db
      .select({ id: agentIncidentEpisodes.id })
      .from(agentIncidentEpisodes)
      .where(
        and(
          eq(agentIncidentEpisodes.projectId, project.id),
          eq(agentIncidentEpisodes.sourceAgentId, agentId),
        ),
      )
      .limit(1),
  ]);

  if (!link.length && !history.length && !attempts.length && !incidents.length)
    throw new MaisterError(
      "PRECONDITION",
      "Agent history is unavailable in this project",
      { details: { reason: "activity_not_found" } },
    );

  return {
    db,
    actor,
    projectId: project.id,
    agentId,
    displayName: history[0]?.name ?? catalog[0]?.name ?? agentId,
    attachmentState: link.length
      ? "attached"
      : catalog.length
        ? "detached"
        : "deleted",
    canReadDefinition: projectRolesForActions(["readRepoFiles"]).includes(
      access.role,
    ),
    canEditSettings:
      link.length > 0 &&
      projectRolesForActions(["editSettings"]).includes(access.role),
    canRetry:
      link[0]?.enabled === true &&
      projectRolesForActions(["launchRun"]).includes(access.role),
  };
}

export type AgentActivityDetail = Omit<
  AgentActivityAccess,
  "db" | "actor" | "projectId"
> & { activity: AgentActivitySummary };

export async function getAgentActivityDetail(
  access: AgentActivityAccess,
): Promise<AgentActivityDetail> {
  const summaries = await getAgentActivitySummaries(
    access.db,
    access.projectId,
    [access.agentId],
  );
  const activity = summaries.get(access.agentId);

  if (!activity)
    throw new MaisterError("CONFIG", "Agent activity summary is unavailable");

  return {
    agentId: access.agentId,
    displayName: access.displayName,
    attachmentState: access.attachmentState,
    canReadDefinition: access.canReadDefinition,
    canEditSettings: access.canEditSettings,
    canRetry: access.canRetry,
    activity,
  };
}

export type AgentDefinitionView = {
  state: "available" | "unavailable";
  reason: string | null;
  agentId: string;
  packageVersion: string | null;
  definitionDigest: string | null;
  prompt: string | null;
  configuration: Record<string, unknown> | null;
};

/** Only the pinned effective definition can populate prompt/configuration; history never depends on its availability. */
export async function getAgentDefinitionView(
  access: AgentActivityAccess,
): Promise<AgentDefinitionView> {
  if (!access.canReadDefinition)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Repository-file permission is required to view agent definitions",
    );
  const unavailable: AgentDefinitionView = {
    state: "unavailable",
    reason: "agent_detached",
    agentId: access.agentId,
    packageVersion: null,
    definitionDigest: null,
    prompt: null,
    configuration: null,
  };

  if (access.attachmentState !== "attached") return unavailable;
  try {
    const effective = await resolveEffectiveAgentDefinition(
      { projectId: access.projectId, agentId: access.agentId },
      access.db,
    );
    const [link] = await access.db
      .select({ config: agentProjectLinks.config })
      .from(agentProjectLinks)
      .where(
        and(
          eq(agentProjectLinks.projectId, access.projectId),
          eq(agentProjectLinks.agentId, access.agentId),
        ),
      );

    if (!link) return unavailable;

    return {
      state: "available",
      reason: null,
      agentId: access.agentId,
      packageVersion: effective.versionLabel,
      definitionDigest: buildAgentActivitySnapshot(access.agentId, effective)
        .definitionSha256,
      prompt: effective.parsed.prompt,
      configuration: resolveAgentConfig(effective.parsed.config, link.config),
    };
  } catch (error) {
    if (
      !isMaisterError(error) ||
      !["PRECONDITION", "CONFIG"].includes(error.code)
    )
      throw error;

    return { ...unavailable, reason: "definition_unavailable" };
  }
}

export function agentActivityErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error) && error.details?.reason === "activity_not_found")
    return NextResponse.json(
      { code: error.code, message: error.message },
      { status: 404 },
    );
  if (isMaisterError(error) && error.code === "CONFIG")
    return NextResponse.json(
      { code: error.code, message: error.message },
      { status: 400 },
    );

  return agentsErrorResponse(error);
}
