import "server-only";

import type { Db } from "./db";
import type { ExecutionHost } from "@/lib/db/schema";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { workspaceEvidenceDigest } from "../../../runtime/workspace-prepare";
import {
  configuredSelectedExecutionEndpoint,
  selectedEndpointAllowsProject,
} from "./selected-endpoint";
import { usesHostWorkspacePreparation } from "./workspace-preparation";

import { executionHosts, projects } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { assertTaskLaunchUserAuthority } from "@/lib/tasks/launch-authority";

const log = pino({
  name: "project-execution-host",
  level: process.env.LOG_LEVEL ?? "info",
});

type ProjectPreference = Pick<
  typeof projects.$inferSelect,
  "defaultExecutionHostId" | "executionHostPreferenceRevision"
>;

export type ProjectHostSettings = Readonly<{
  defaultExecutionHostId: string | null;
  preferenceRevision: number;
  eligibilityRevision: string;
}>;

export type TaskLaunchHostSelection = Readonly<{
  requestedExecutionHostId: string | null;
  effectiveExecutionHostId: string;
  provenance: "explicit" | "projectDefault" | "instanceDefault" | "sharedRoot";
  eligibilityRevision: string;
}>;

export type TaskLaunchPlacement = Readonly<{
  selection: TaskLaunchHostSelection;
  preferenceRevision: number;
}>;

function eligibleForProject(projectId: string, host: ExecutionHost): boolean {
  return (
    host.retiredAt === null &&
    host.readinessReason !== "identity_changed" &&
    usesHostWorkspacePreparation(host) &&
    selectedEndpointAllowsProject(projectId)
  );
}

async function eligibleHostIds(
  tx: Db,
  projectId: string,
): Promise<readonly string[]> {
  const endpoint = configuredSelectedExecutionEndpoint();
  if (!endpoint) return [];
  const [host] = await tx
    .select()
    .from(executionHosts)
    .where(
      and(
        eq(executionHosts.hostKey, endpoint.hostKey),
        isNull(executionHosts.retiredAt),
      ),
    )
    .for("share");

  return host && eligibleForProject(projectId, host) ? [host.id] : [];
}

function projectHostSettings(
  project: ProjectPreference,
  eligibleIds: readonly string[],
): ProjectHostSettings {
  return {
    defaultExecutionHostId: project.defaultExecutionHostId,
    preferenceRevision: project.executionHostPreferenceRevision,
    eligibilityRevision: workspaceEvidenceDigest(eligibleIds),
  };
}

export function projectHostSettingsEtag(settings: ProjectHostSettings): string {
  return `"${settings.preferenceRevision}:${settings.eligibilityRevision}"`;
}

function settingsChanged(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Project host settings changed. Refresh the settings before saving.",
    {
      details: { reason: "settings_revision_mismatch" },
    },
  );
}

function ineligibleHost(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "The selected execution host is not eligible for this project",
    {
      details: { reason: "host_ineligible" },
    },
  );
}

/** Resolve the authorized project's configured identity without a readiness probe. */
export async function resolveTaskLaunchPlacement(
  db: Db,
  project: ProjectPreference & { id: string },
  requested: string | undefined,
): Promise<TaskLaunchPlacement | null> {
  if (
    !configuredSelectedExecutionEndpoint() &&
    !project.defaultExecutionHostId &&
    !requested
  )
    return null;
  const eligibleIds = await eligibleHostIds(db, project.id);
  const effective =
    requested ?? project.defaultExecutionHostId ?? eligibleIds[0];
  if (!effective || !eligibleIds.includes(effective)) throw ineligibleHost();

  return {
    preferenceRevision: project.executionHostPreferenceRevision,
    selection: {
      requestedExecutionHostId: requested ?? null,
      effectiveExecutionHostId: effective,
      provenance: requested
        ? "explicit"
        : project.defaultExecutionHostId
          ? "projectDefault"
          : "instanceDefault",
      eligibilityRevision: workspaceEvidenceDigest(eligibleIds),
    },
  };
}

export function bindTaskLaunchPlacementToken(
  settingsToken: string,
  placement: TaskLaunchPlacement | null,
): string {
  return placement
    ? workspaceEvidenceDigest({ settingsToken, placement })
    : settingsToken;
}

/** An accepted launch checks the original identity against current operator eligibility. */
export async function assertAcceptedTaskLaunchHost(
  db: Db,
  projectId: string,
  executionHostId: string | null,
): Promise<void> {
  if (
    executionHostId !== null &&
    !(await eligibleHostIds(db, projectId)).includes(executionHostId)
  )
    throw ineligibleHost();
}

export function assertBoundTaskLaunchHost(
  expectedHostId: string | null | undefined,
  host: ExecutionHost,
): void {
  if (expectedHostId && expectedHostId !== host.id)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "Accepted launch is waiting for its selected supervisor",
      { details: { reason: "host_ineligible" } },
    );
}

export function assertProjectExecutionHost(
  project: Pick<typeof projects.$inferSelect, "id" | "defaultExecutionHostId">,
  host: ExecutionHost,
): void {
  if (project.defaultExecutionHostId != null) {
    if (
      project.defaultExecutionHostId !== host.id ||
      !eligibleForProject(project.id, host)
    )
      throw ineligibleHost();
  } else if (
    usesHostWorkspacePreparation(host) &&
    !eligibleForProject(project.id, host)
  ) {
    throw ineligibleHost();
  }
}

export async function readProjectHostSettings(
  db: Db,
  projectId: string,
  userId: string,
): Promise<ProjectHostSettings> {
  return db.transaction(async (tx) => {
    await assertTaskLaunchUserAuthority(tx, projectId, userId, [
      "editSettings",
    ]);
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) throw settingsChanged();

    return projectHostSettings(project, await eligibleHostIds(tx, projectId));
  });
}

export async function updateProjectHostSettings(
  db: Db,
  input: Readonly<{
    projectId: string;
    userId: string;
    ifMatch: string | null;
    defaultExecutionHostId: string | null;
  }>,
): Promise<ProjectHostSettings> {
  const { projectId, userId, defaultExecutionHostId } = input;
  const updated = await db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    await assertTaskLaunchUserAuthority(tx, projectId, userId, [
      "editSettings",
    ]);
    if (!project) throw settingsChanged();
    const eligibleIds = await eligibleHostIds(tx, projectId);
    const current = projectHostSettings(project, eligibleIds);
    if (input.ifMatch !== projectHostSettingsEtag(current))
      throw settingsChanged();
    if (
      defaultExecutionHostId !== null &&
      !eligibleIds.includes(defaultExecutionHostId)
    )
      throw ineligibleHost();
    if (current.preferenceRevision === Number.MAX_SAFE_INTEGER)
      throw settingsChanged();

    const [saved] = await tx
      .update(projects)
      .set({
        defaultExecutionHostId,
        executionHostPreferenceRevision: current.preferenceRevision + 1,
      })
      .where(eq(projects.id, projectId))
      .returning();

    return projectHostSettings(saved, eligibleIds);
  });
  log.info(
    {
      projectId,
      userId,
      defaultExecutionHostId,
      preferenceRevision: updated.preferenceRevision,
    },
    "project-execution-host-preference-updated",
  );

  return updated;
}
