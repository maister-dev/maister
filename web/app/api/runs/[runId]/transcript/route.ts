import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { getRunDetail } from "@/lib/queries/run";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import {
  getRunNodeTranscript,
  projectRunTranscript,
} from "@/lib/runs/run-transcript-projector";

const log = pino({
  name: "api-run-transcript",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

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

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "GET /api/runs/[runId]/transcript");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// GET /api/runs/{runId}/transcript?node={nodeId}
// Per-node-attempt agent transcript for a flow run. Authz is `readRepoFiles`
// (MEMBER) — a transcript exposes tool outputs / file contents a viewer must
// not see (mirrors the workbench file-content gate, NOT readBoard/viewer).
export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const detail = await getRunDetail(runId);

    if (!detail) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(detail.projectId, "readRepoFiles");

    const nodeId = new URL(req.url).searchParams.get("node");

    if (!nodeId) {
      throw new MaisterError("CONFIG", "missing node query parameter");
    }

    // Server-state validation: the node must belong to this run's compiled
    // graph. Never a path/body value — an unknown node is a typed PRECONDITION.
    const loaded = await loadRunManifest(runId);

    if (!loaded) {
      throw new MaisterError("PRECONDITION", "run has no compiled flow graph");
    }

    const compiled = compileManifest(loaded.manifest);

    if (!compiled.nodes.has(nodeId)) {
      throw new MaisterError("PRECONDITION", `unknown node for run: ${nodeId}`);
    }

    await projectRunTranscript(runId);
    const transcript = await getRunNodeTranscript(runId, nodeId);

    return NextResponse.json({
      messages: transcript?.messages ?? [],
      usage: transcript?.usage ?? null,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
