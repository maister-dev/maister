import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import {
  agentMemoryPath,
  readAgentMemoryRaw,
  writeAgentMemoryCas,
  type AgentMemoryState,
} from "@/lib/agents/memory-store";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { agentMemoryMaxChars } from "@/lib/instance-config";
import { decodeRouteParam } from "@/lib/route-params";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agentProjectLinks, projects } = schemaModule as unknown as Record<
  string,
  any
>;

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

const log = pino({
  name: "project-agent-memory-route",
  level: process.env.LOG_LEVEL ?? "info",
});

const putBodySchema = z
  .object({
    content: z.string(),
    // ADR-152 D18: required, not optional. CAS applies to the human too — a
    // blind Save would clobber a concurrent agent write.
    ifHash: z.string().min(1).nullable(),
  })
  .strict();

function serialize(state: AgentMemoryState) {
  return {
    content: state.content,
    hash: state.hash,
    sizeChars: state.sizeChars,
    // The drawer renders a live `sizeChars / max` indicator, so the resolved cap
    // travels with the state rather than being duplicated client-side.
    maxChars: agentMemoryMaxChars(),
    updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
  };
}

// The attachment is the addressable resource: memory for an agent this project
// has not attached does not exist here, which is a 404 on this surface (the
// sibling link route uses the same contract).
async function resolveAttachment(
  slug: string,
  agentId: string,
): Promise<{ projectId: string }> {
  const db = getDb() as unknown as { select: any };
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  const links = await db
    .select({ id: agentProjectLinks.id })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, agentId),
        eq(agentProjectLinks.projectId, project.id),
      ),
    );

  if (links.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `agent ${agentId} is not attached to ${slug}`,
    );
  }

  return { projectId: project.id as string };
}

function notAttachedTo404(err: unknown): NextResponse | null {
  if (
    err instanceof MaisterError &&
    (err.message.includes("is not attached") ||
      err.message.includes("project not found"))
  ) {
    return NextResponse.json(
      { code: "PRECONDITION", message: err.message },
      { status: 404 },
    );
  }

  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");
    const { projectId } = await resolveAttachment(slug, agentId);

    await requireProjectAction(projectId, "readBoard");

    const state = await readAgentMemoryRaw(slug, agentId);

    return NextResponse.json(serialize(state), { status: 200 });
  } catch (err) {
    return notAttachedTo404(err) ?? agentsErrorResponse(err);
  }
}

export async function PUT(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    const actor = await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");
    const { projectId } = await resolveAttachment(slug, agentId);

    await requireProjectAction(projectId, "editSettings");

    let raw: unknown;

    try {
      raw = await req.json();
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = putBodySchema.safeParse(raw);

    if (!parsed.success) {
      throw new MaisterError("CONFIG", `invalid body: ${parsed.error.message}`);
    }

    const max = agentMemoryMaxChars();

    if (parsed.data.content.length > max) {
      throw new MaisterError(
        "CONFIG",
        `agent memory: content is ${parsed.data.content.length} characters, over the ${max}-character cap`,
      );
    }

    const result = await writeAgentMemoryCas(
      slug,
      agentId,
      parsed.data.content,
      parsed.data.ifHash,
    );

    if (!result.ok) {
      return NextResponse.json(
        {
          code: "CONFLICT",
          message:
            "agent memory changed since it was loaded — merge the returned content and save again",
          current: serialize(result.current),
        },
        { status: 409 },
      );
    }

    log.info(
      { actorUserId: actor.id, agentId, projectId, sizeChars: parsed.data.content.length },
      "[agents.memory] owner write",
    );

    return NextResponse.json(serialize(await readAgentMemoryRaw(slug, agentId)), {
      status: 200,
    });
  } catch (err) {
    return notAttachedTo404(err) ?? agentsErrorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    const actor = await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");
    const { projectId } = await resolveAttachment(slug, agentId);

    await requireProjectAction(projectId, "editSettings");

    const { unlink } = await import("node:fs/promises");

    try {
      await unlink(agentMemoryPath(slug, agentId));
    } catch (err) {
      const code = (err as { code?: string }).code;

      // Idempotent: clearing an already-absent file succeeds. Only the "absent"
      // errnos are allow-listed — EACCES and friends must still surface.
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") {
        throw err;
      }
    }

    log.info(
      { actorUserId: actor.id, agentId, projectId },
      "[agents.memory] owner clear",
    );

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return notAttachedTo404(err) ?? agentsErrorResponse(err);
  }
}
