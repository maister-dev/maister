import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";

import {
  requireActiveSession,
  requireProjectAction,
  type ProjectAction,
} from "@/lib/authz";
import {
  concludeBrainProposal,
  getBrainProposal,
  type BrainProposalTransactionalDb,
} from "@/lib/brain/proposals";
import type { BrainProposalKind } from "@/lib/brain/schema";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

type RouteParams = {
  params: Promise<{ slug: string; proposalId: string }>;
};

const conclusionBodySchema = z
  .object({
    action: z.enum(["accept", "reject"]),
    reason: z.string().max(2000).optional(),
  })
  .strict();

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 404;
    case "CONFIG":
      return 422;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof SyntaxError || err instanceof ZodError) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid request body: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }

  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadProject(slug: string) {
  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

function acceptActionForKind(kind: BrainProposalKind): ProjectAction {
  if (kind === "rule" || kind === "skill" || kind === "flow") {
    return "manageCatalog";
  }

  return "createTask";
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, proposalId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await loadProject(slug);
    const db = getDb() as unknown as BrainProposalTransactionalDb;

    await requireProjectAction(project.id, "writeBrain");

    const body = conclusionBodySchema.parse(await req.json());

    if (body.action === "accept") {
      const proposal = await getBrainProposal(db, project.id, proposalId);

      await requireProjectAction(project.id, acceptActionForKind(proposal.kind));
    }

    const proposal = await concludeBrainProposal(db, {
      projectId: project.id,
      projectSlug: slug,
      proposalId,
      action: body.action,
      actor: { type: "user", id: user.id },
      reason: body.reason,
    });

    return NextResponse.json(proposal, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
