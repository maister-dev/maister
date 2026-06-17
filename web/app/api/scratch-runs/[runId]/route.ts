import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { extractOptions } from "@/lib/queries/hitl";

// FIXME(any): dual drizzle-orm peer-dep variants.
const {
  runs,
  projects,
  hitlRequests,
  scratchAttachments,
  scratchCapabilityProfiles,
  scratchMessages,
  scratchRuns,
  users,
  workspaces,
} = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-scratch-run",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };
// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = { select: any; update: any };
type ScratchWorkspaceRow = {
  id?: string;
  branch: string;
  removedAt: Date | string | null;
};
type ScratchCapabilityProfileRow = {
  profileDigest: string;
  selectedMcpIds: string[];
  selectedSkillIds: string[];
  selectedRuleIds: string[];
  restrictions: Record<string, unknown>;
  downgradeNotes: Record<string, unknown> | null;
};
type ScratchAttachmentRow = {
  id: string;
  runId: string;
  messageId: string | null;
  kind: string;
  label: string | null;
  value: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  createdAt: Date | string;
};
type PendingHitlRow = {
  id: string;
  kind: "permission" | "form" | "human";
  prompt: string;
  schema: unknown;
  respondedAt: Date | null;
};
type PublicRunnerSnapshot = {
  id: string;
  adapter: string;
  capabilityAgent: string;
  model: string;
  providerKind: string;
  permissionPolicy: string;
  sidecarId: string | null;
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

  log.error({ err: message }, "/api/scratch-runs/[runId] error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadScratchRun(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

  const scratchRows = await db
    .select()
    .from(scratchRuns)
    .where(eq(scratchRuns.runId, runId));
  const scratch = scratchRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }

  return { run, scratch };
}

function publicWorkspace(
  row: ScratchWorkspaceRow | undefined,
): { id?: string; branch: string; removedAt: Date | string | null } | null {
  if (!row) return null;

  return {
    id: row.id,
    branch: row.branch,
    removedAt: row.removedAt,
  };
}

function publicCapabilityProfile(
  row: ScratchCapabilityProfileRow | undefined,
):
  | (ScratchCapabilityProfileRow & { selectedAgentDefinitionIds: string[] })
  | null {
  if (!row) return null;

  const restrictionIds = Array.isArray(row.restrictions.selectedRestrictionIds)
    ? row.restrictions.selectedRestrictionIds
    : [];
  const agentDefinitionIds = Array.isArray(
    row.restrictions.selectedAgentDefinitionIds,
  )
    ? row.restrictions.selectedAgentDefinitionIds
    : [];

  return {
    profileDigest: row.profileDigest,
    selectedMcpIds: row.selectedMcpIds,
    selectedSkillIds: row.selectedSkillIds,
    selectedRuleIds: row.selectedRuleIds,
    selectedAgentDefinitionIds: agentDefinitionIds,
    restrictions: {
      ...row.restrictions,
      selectedRestrictionIds: restrictionIds,
    },
    downgradeNotes: row.downgradeNotes,
  };
}

function publicAttachment(row: ScratchAttachmentRow) {
  const artifactRef = row.kind === "uploaded_file" ? row.value : null;

  return {
    id: row.id,
    runId: row.runId,
    messageId: row.messageId,
    kind: row.kind,
    label: row.label,
    value: row.value,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    artifactRef,
    createdAt: row.createdAt,
  };
}

function publicHitlSchema(row: PendingHitlRow): unknown {
  if (row.kind !== "permission") return row.schema;

  return {
    options: extractOptions(row.kind, row.schema),
  };
}

function publicRunnerSnapshot(raw: unknown): PublicRunnerSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;

  const snapshot = raw as {
    id?: unknown;
    adapter?: unknown;
    capabilityAgent?: unknown;
    model?: unknown;
    providerKind?: unknown;
    permissionPolicy?: unknown;
    sidecarId?: unknown;
  };

  if (
    typeof snapshot.id !== "string" ||
    typeof snapshot.adapter !== "string" ||
    typeof snapshot.capabilityAgent !== "string" ||
    typeof snapshot.model !== "string" ||
    typeof snapshot.providerKind !== "string" ||
    typeof snapshot.permissionPolicy !== "string"
  ) {
    return null;
  }

  return {
    id: snapshot.id,
    adapter: snapshot.adapter,
    capabilityAgent: snapshot.capabilityAgent,
    model: snapshot.model,
    providerKind: snapshot.providerKind,
    permissionPolicy: snapshot.permissionPolicy,
    sidecarId:
      typeof snapshot.sidecarId === "string" ? snapshot.sidecarId : null,
  };
}

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    const { run, scratch } = await loadScratchRun(db, runId);

    await requireProjectAction(run.projectId, "readScratchRun");

    const [
      projectRows,
      workspaceRows,
      messageRows,
      attachmentRows,
      profileRows,
      pendingHitlRows,
      creatorRows,
    ] = await Promise.all([
      db.select().from(projects).where(eq(projects.id, run.projectId)),
      db.select().from(workspaces).where(eq(workspaces.runId, runId)),
      db.select().from(scratchMessages).where(eq(scratchMessages.runId, runId)),
      db
        .select()
        .from(scratchAttachments)
        .where(eq(scratchAttachments.runId, runId)),
      db
        .select()
        .from(scratchCapabilityProfiles)
        .where(eq(scratchCapabilityProfiles.runId, runId)),
      db.select().from(hitlRequests).where(eq(hitlRequests.runId, runId)),
      (run.createdByUserId ?? scratch.createdByUserId)
        ? db
            .select()
            .from(users)
            .where(eq(users.id, run.createdByUserId ?? scratch.createdByUserId))
        : Promise.resolve([]),
    ]);
    const creator = creatorRows[0];
    const projectSlug =
      (projectRows[0] as { slug?: string } | undefined)?.slug ?? null;
    const pendingHitl =
      (pendingHitlRows.find(
        (row: PendingHitlRow) => row.respondedAt === null,
      ) as PendingHitlRow | undefined) ?? null;

    return NextResponse.json({
      run: {
        id: run.id,
        projectId: run.projectId,
        projectSlug,
        runnerId: run.runnerId,
        runnerResolutionTier: run.runnerResolutionTier,
        capabilityAgent: run.capabilityAgent,
        runnerSnapshot: publicRunnerSnapshot(run.runnerSnapshot),
        createdByUserId: run.createdByUserId ?? scratch.createdByUserId ?? null,
        createdByDisplayName: creator?.name ?? creator?.email ?? null,
        status: run.status,
        currentStepId: run.currentStepId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      },
      scratch: {
        name: scratch.name,
        workMode: scratch.workMode,
        reasoningEffort: scratch.reasoningEffort,
        planMode: scratch.planMode,
        linkedTaskId: scratch.linkedTaskId,
        linkedIssueUrl: scratch.linkedIssueUrl,
        baseBranch: scratch.baseBranch,
        baseCommit: scratch.baseCommit,
        targetBranch: scratch.targetBranch,
        dialogStatus: scratch.dialogStatus,
        errorCode: scratch.errorCode,
        errorMessage: scratch.errorMessage,
        lastUserMessageAt: scratch.lastUserMessageAt,
        lastAgentMessageAt: scratch.lastAgentMessageAt,
      },
      workspace: publicWorkspace(workspaceRows[0]),
      messages: [...messageRows].sort(
        (a: { sequence: number }, b: { sequence: number }) =>
          a.sequence - b.sequence,
      ),
      attachments: attachmentRows.map(publicAttachment),
      capabilityProfile: publicCapabilityProfile(profileRows[0]),
      pendingHitl: pendingHitl
        ? {
            hitlRequestId: pendingHitl.id,
            kind: pendingHitl.kind,
            prompt: pendingHitl.prompt,
            schema: publicHitlSchema(pendingHitl),
            options: extractOptions(pendingHitl.kind, pendingHitl.schema),
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    // projectId is server-state (resolved from the run row), never a body
    // field. loadScratchRun also enforces the scratch-only guard: a missing
    // or non-scratch run throws PRECONDITION (409).
    const { run } = await loadScratchRun(db, runId);
    const projectId = run.projectId as string;

    await requireProjectAction(projectId, "renameScratchRun");

    // name is body-controlled: validated for shape only (trimmed, 1..200,
    // non-empty) and written through a parameterized UPDATE — never used as a
    // path component or interpolated into SQL.
    const body = (await req.json().catch(() => ({}))) as { name?: unknown };

    if (typeof body.name !== "string") {
      throw new MaisterError("CONFIG", "name is required");
    }
    const name = body.name.trim();

    if (name.length < 1 || name.length > 200) {
      throw new MaisterError("CONFIG", "name must be 1 to 200 characters");
    }

    await db
      .update(scratchRuns)
      .set({ name })
      .where(eq(scratchRuns.runId, runId));

    log.info({ runId, projectId }, "scratch run renamed");

    return NextResponse.json({ ok: true, name });
  } catch (err) {
    return errorResponse(err);
  }
}
