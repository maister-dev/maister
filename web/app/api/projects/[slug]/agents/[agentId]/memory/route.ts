import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { lockVaultCutover } from "@/lib/agent-memory-vault/cutover";
import {
  mutateCompatibleVaultIndex,
  readCompatibleVaultIndex,
} from "@/lib/agent-memory-vault/index-compatibility";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import { privateJson } from "@/lib/api/private-json";
import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import {
  assertAgentMemoryWithinCap,
  clearAgentMemoryCas,
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

// ADR-152 D27: clearing carries the same required `ifHash` as saving. `null`
// means "I expect no file", so clearing an already-absent file still succeeds
// and DELETE stays idempotent. A body on DELETE follows the existing
// studio/local-packages/[id]/files precedent.
const deleteBodySchema = z
  .object({ ifHash: z.string().min(1).nullable() })
  .strict();

function serialize(state: AgentMemoryState, maxChars: number) {
  return {
    content: state.content,
    hash: state.hash,
    sizeChars: state.sizeChars,
    // The drawer renders a live `sizeChars / max` indicator, so the resolved cap
    // travels with the state rather than being duplicated client-side.
    maxChars,
    updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
  };
}

// The attachment is the addressable resource: memory for a project or an agent
// this project has not attached does not exist HERE, so both are 404 on this
// surface. Returned as a discriminated result rather than thrown, because the
// repo rule is that callers branch on a typed value — never on `err.message`
// matching, which silently breaks the moment a message is reworded.
type AttachmentLookup =
  | { ok: true; projectId: string }
  | { ok: false; missing: "project" | "attachment" };

async function resolveAttachment(
  slug: string,
  agentId: string,
): Promise<AttachmentLookup> {
  const db = getDb() as unknown as { select: any };
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    return { ok: false, missing: "project" };
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
    return { ok: false, missing: "attachment" };
  }

  return { ok: true, projectId: project.id as string };
}

function notFound(lookup: { missing: "project" | "attachment" }): NextResponse {
  return NextResponse.json(
    {
      code: "PRECONDITION",
      message:
        lookup.missing === "project"
          ? "project not found"
          : "agent is not attached to this project",
    },
    { status: 404 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    const actor = await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");
    const lookup = await resolveAttachment(slug, agentId);

    if (!lookup.ok) return notFound(lookup);

    // ADR-152 D28: `readRepoFiles` (member), NOT `readBoard` (viewer). The agent
    // writes this file with repo access, so it can hold copied or summarized
    // source — reading it at viewer level would be a side channel around the
    // ADR-053 boundary that keeps git-tracked file browsing above `readBoard`.
    await requireProjectAction(lookup.projectId, "readRepoFiles");

    const response = await getDb().transaction(async (tx) => {
      if ((await lockVaultCutover(tx)) === null)
        return serialize(
          await readAgentMemoryRaw(slug, agentId),
          agentMemoryMaxChars(),
        );

      return serialize(
        await readCompatibleVaultIndex(
          tx,
          prepareHumanProjectVault({
            userId: actor.id,
            slug,
            agentId,
            action: "readRepoFiles",
          }),
        ),
        agentMemoryVaultLimits().indexChars,
      );
    });

    return privateJson(response);
  } catch (err) {
    return agentsErrorResponse(err);
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
    const lookup = await resolveAttachment(slug, agentId);

    if (!lookup.ok) return notFound(lookup);

    const projectId = lookup.projectId;

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

    const { result, cap } = await getDb().transaction(async (tx) => {
      if ((await lockVaultCutover(tx)) !== null)
        return {
          result: await mutateCompatibleVaultIndex(
            tx,
            prepareHumanProjectVault({
              userId: actor.id,
              slug,
              agentId,
              action: "editSettings",
            }),
            parsed.data,
          ),
          cap: agentMemoryVaultLimits().indexChars,
        };
      assertAgentMemoryWithinCap(parsed.data.content);

      return {
        result: await writeAgentMemoryCas(
          tx,
          slug,
          agentId,
          parsed.data.content,
          parsed.data.ifHash,
        ),
        cap: agentMemoryMaxChars(),
      };
    });

    if ("status" in result) return privateJson(result, 202);
    if (!result.ok) {
      return privateJson(
        {
          code: "CONFLICT",
          message:
            "agent memory changed since it was loaded — merge the returned content and save again",
          current: serialize(result.current, cap),
        },
        409,
      );
    }

    log.info(
      {
        actorUserId: actor.id,
        agentId,
        projectId,
        sizeChars: parsed.data.content.length,
      },
      "[agents.memory] owner write",
    );

    // This write's own post-write state, captured under the CAS lock.
    return privateJson(serialize(result.state, cap));
  } catch (err) {
    return agentsErrorResponse(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, agentId: rawAgentId } = await params;

  try {
    const actor = await requireActiveSession();
    const agentId = decodeRouteParam(rawAgentId, "agentId");
    const lookup = await resolveAttachment(slug, agentId);

    if (!lookup.ok) return notFound(lookup);

    const projectId = lookup.projectId;

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

    const parsed = deleteBodySchema.safeParse(raw);

    if (!parsed.success) {
      throw new MaisterError("CONFIG", `invalid body: ${parsed.error.message}`);
    }

    // ADR-152 D27: compare-and-delete, same lock and same bar as the write CAS.
    // A blind unlink would destroy a concurrent agent write with a 204 and no
    // conflict signal — the exact clobber D18 refuses to let a blind Save do.
    const { result, cap } = await getDb().transaction(async (tx) => {
      if ((await lockVaultCutover(tx)) !== null)
        return {
          result: await mutateCompatibleVaultIndex(
            tx,
            prepareHumanProjectVault({
              userId: actor.id,
              slug,
              agentId,
              action: "editSettings",
            }),
            { content: null, ifHash: parsed.data.ifHash },
          ),
          cap: agentMemoryVaultLimits().indexChars,
        };

      return {
        result: await clearAgentMemoryCas(
          tx,
          slug,
          agentId,
          parsed.data.ifHash,
        ),
        cap: agentMemoryMaxChars(),
      };
    });

    if ("status" in result) return privateJson(result, 202);
    if (!result.ok) {
      return privateJson(
        {
          code: "CONFLICT",
          message:
            "agent memory changed since it was loaded — review the returned content before clearing again",
          current: serialize(result.current, cap),
        },
        409,
      );
    }

    log.info(
      { actorUserId: actor.id, agentId, projectId },
      "[agents.memory] owner clear",
    );

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
