import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { loadSelectableCapabilities } from "@/lib/capabilities/resolver";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { deriveScratchBranchName } from "@/lib/scratch-runs/launch";
import { listBranches } from "@/lib/worktree";

const { executors, projectMembers, projects } =
  schemaModule as unknown as Record<string, any>;

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

function executorLabel(row: any): string {
  const router = row.router ? ` via ${row.router}` : "";

  return `${row.executorRefId} · ${row.agent} · ${row.model}${router}`;
}

function envHint(row: any): string | null {
  if (!row.env || typeof row.env !== "object") return null;

  const keys = Object.keys(row.env);

  return keys.length > 0 ? keys.sort().join(", ") : null;
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
        defaultExecutorId: null,
        branches: [],
        executors: [],
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

    const [branchRows, executorRows, capabilities] = await Promise.all([
      listBranches(project.repoPath),
      db.select().from(executors).where(eq(executors.projectId, project.id)),
      loadSelectableCapabilities(project.id, db),
    ]);
    const defaultScratchBranch = deriveScratchBranchName({
      branchPrefix: project.branchPrefix,
      projectSlug: project.slug,
      requestedName: "scratch",
      runId: randomUUID(),
    });
    const mcps = capabilities.filter((record) => record.kind === "mcp");
    const defaultExecutorId =
      project.defaultExecutorId ??
      executorRows.find((row: any) => row.id)?.id ??
      null;

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
        defaultExecutorId: row.defaultExecutorId ?? null,
      })),
      selectedProjectId: project.id,
      defaultBaseBranch: project.mainBranch,
      defaultScratchBranch,
      defaultExecutorId,
      branches: branchRows,
      executors: executorRows.map((row: any) => ({
        id: row.id,
        executorRefId: row.executorRefId,
        displayLabel: executorLabel(row),
        agent: row.agent,
        model: row.model,
        router: row.router,
        envHint: envHint(row),
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
