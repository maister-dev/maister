import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  resolveRunner,
  type RunnerCatalogEntry,
} from "@/lib/acp-runners/resolve";
import { loadSelectableCapabilities } from "@/lib/capabilities/resolver";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { deriveScratchBranchName } from "@/lib/scratch-runs/launch";
import { listBranches } from "@/lib/worktree";

const {
  platformAcpRunners,
  platformRuntimeSettings,
  projectMembers,
  projects,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-scratch-launch-options",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = {
  select: any;
};

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "GET /api/scratch-runs/launch-options error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function visibleProjects(db: Db, user: { id: string; role: string }) {
  if (user.role === "admin") {
    return db.select().from(projects).where(isNull(projects.archivedAt));
  }

  const membershipRows = await db
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  const projectIds = membershipRows.map(
    (row: { projectId: string }) => row.projectId,
  );

  if (projectIds.length === 0) return [];

  return db
    .select()
    .from(projects)
    .where(and(inArray(projects.id, projectIds), isNull(projects.archivedAt)));
}

function selectedProject(
  projectRows: readonly any[],
  requestedProjectId: string | null,
) {
  if (projectRows.length === 0) return null;
  if (!requestedProjectId) return projectRows[0];

  const project = projectRows.find((row) => row.id === requestedProjectId);

  if (!project) {
    throw new MaisterError(
      "PRECONDITION",
      `project not visible: ${requestedProjectId}`,
    );
  }

  return project;
}

function capabilityOption(record: any) {
  return {
    id: record.capabilityRefId,
    recordId: record.id,
    kind: record.kind,
    label: record.label,
    source: record.source,
    enforceability: record.enforceability,
    selectedByDefault: record.selectedByDefault,
    agents: record.agents,
  };
}

function runnerProviderKind(provider: unknown): string {
  if (
    provider &&
    typeof provider === "object" &&
    "kind" in provider &&
    typeof provider.kind === "string"
  ) {
    return provider.kind;
  }

  throw new MaisterError(
    "CONFIG",
    `platform ACP runner has invalid provider payload: ${JSON.stringify(provider)}`,
  );
}

function runnerCatalogEntry(row: Record<string, any>): RunnerCatalogEntry {
  return {
    id: row.id,
    adapter: row.adapter,
    capabilityAgent: row.capabilityAgent,
    model: row.model,
    providerKind: runnerProviderKind(row.provider),
    permissionPolicy: row.permissionPolicy,
    sidecarId: row.sidecarId,
    enabled: row.enabled,
    ready: row.readinessStatus === "Ready",
  };
}

function runnerLabel(row: RunnerCatalogEntry): string {
  const sidecar = row.sidecarId ? ` via ${row.sidecarId}` : "";

  return `${row.id} · ${row.model}${sidecar}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const db = getDb() as unknown as Db;
    const url = new URL(req.url);
    const requestedProjectId = url.searchParams.get("projectId");
    const projectRows = await visibleProjects(db, user);
    const project = selectedProject(projectRows, requestedProjectId);

    if (!project) {
      return NextResponse.json({
        machine: {
          id: "local",
          label: "Local machine",
          readOnly: true,
        },
        projects: [],
        selectedProjectId: null,
        defaultBaseBranch: null,
        defaultScratchBranch: null,
        defaultRunnerId: null,
        branches: [],
        runners: [],
        workModes: [
          { id: "auto", label: "Auto", selectedByDefault: true },
          { id: "plan_first", label: "Plan first", selectedByDefault: false },
          {
            id: "manual_approval",
            label: "Manual approval",
            selectedByDefault: false,
          },
        ],
        reasoningEfforts: [
          { id: "low", label: "Low", selectedByDefault: false },
          { id: "high", label: "High", selectedByDefault: true },
          { id: "extra", label: "Extra", selectedByDefault: false },
          { id: "ultra", label: "Ultra", selectedByDefault: false },
        ],
        capabilities: {
          mcps: [],
          skills: [],
          rules: [],
          agentDefinitions: [],
          restrictions: [],
          defaultSelectedMcpIds: [],
        },
      });
    }

    const [branchRows, runnerRows, runtimeRows, capabilities] =
      await Promise.all([
        listBranches(project.repoPath, { includeRemotes: true }),
        db.select().from(platformAcpRunners),
        db
          .select()
          .from(platformRuntimeSettings)
          .where(eq(platformRuntimeSettings.id, "singleton")),
        loadSelectableCapabilities(project.id, db),
      ]);
    const defaultScratchBranch = deriveScratchBranchName({
      branchPrefix: project.branchPrefix,
      projectSlug: project.slug,
      requestedName: "scratch",
      runId: randomUUID(),
    });
    const mcps = capabilities.filter((record) => record.kind === "mcp");
    const platformRuntime = runtimeRows[0];

    if (!platformRuntime) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "platform default ACP runner is not configured",
      );
    }

    const runnerCatalog = runnerRows.map(runnerCatalogEntry);
    const defaultRunnerId = resolveRunner({
      launchOverrideRunnerId: null,
      step: { runnerId: null },
      projectFlow: { defaultRunnerId: null },
      platformFlow: { defaultRunnerId: null },
      project: { defaultRunnerId: project.defaultRunnerId },
      platform: { defaultRunnerId: platformRuntime.defaultRunnerId },
      runners: runnerCatalog,
    }).runnerId;

    return NextResponse.json({
      machine: {
        id: "local",
        label: "Local machine",
        readOnly: true,
      },
      projects: projectRows.map((row: any) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        mainBranch: row.mainBranch,
        branchPrefix: row.branchPrefix,
        defaultRunnerId: row.defaultRunnerId ?? null,
      })),
      selectedProjectId: project.id,
      defaultBaseBranch: project.mainBranch,
      defaultScratchBranch,
      defaultRunnerId,
      branches: branchRows,
      runners: runnerCatalog.map((row: RunnerCatalogEntry) => ({
        id: row.id,
        displayLabel: runnerLabel(row),
        adapter: row.adapter,
        capabilityAgent: row.capabilityAgent,
        model: row.model,
        providerKind: row.providerKind,
        permissionPolicy: row.permissionPolicy,
        sidecarId: row.sidecarId ?? null,
        enabled: row.enabled,
        ready: row.ready,
      })),
      workModes: [
        { id: "auto", label: "Auto", selectedByDefault: true },
        { id: "plan_first", label: "Plan first", selectedByDefault: false },
        {
          id: "manual_approval",
          label: "Manual approval",
          selectedByDefault: false,
        },
      ],
      reasoningEfforts: [
        { id: "low", label: "Low", selectedByDefault: false },
        { id: "high", label: "High", selectedByDefault: true },
        { id: "extra", label: "Extra", selectedByDefault: false },
        { id: "ultra", label: "Ultra", selectedByDefault: false },
      ],
      capabilities: {
        mcps: mcps.map(capabilityOption),
        skills: capabilities
          .filter((record) => record.kind === "skill")
          .map(capabilityOption),
        rules: capabilities
          .filter((record) => record.kind === "rule")
          .map(capabilityOption),
        agentDefinitions: capabilities
          .filter((record) => record.kind === "agent_definition")
          .map(capabilityOption),
        restrictions: capabilities
          .filter((record) => record.kind === "restriction")
          .map(capabilityOption),
        defaultSelectedMcpIds: mcps
          .filter((record) => record.selectedByDefault)
          .map((record) => record.capabilityRefId),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
