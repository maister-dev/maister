import "server-only";

import type { BrainItemKind } from "@/lib/brain/schema";
import type { ExtCtx } from "@/lib/tokens/ext-handler";
import type { TokenActor } from "@/lib/tokens/verify";

import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { recall, writeBrainSnapshot } from "@/lib/brain/recall";
import { RANKER_VERSION } from "@/lib/brain/recall-ranker";
import { retain } from "@/lib/brain/retain";
import { getBrainEmbeddingClient } from "@/lib/brain/openai-compatible";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT_GET = "GET /api/v1/ext/projects/[slug]/memory";
const ENDPOINT_POST = "POST /api/v1/ext/projects/[slug]/memory";

type RouteParams = { params: Promise<{ slug: string }> };

const KINDS = ["lesson", "observation", "state_fact"] as const;

// FIXME(any): dual drizzle-orm peer-dep — the ext db handle is untyped upstream.

type Db = any;

function extError(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForExtCode(err.code) },
    );
  }

  throw err;
}

function forbidden(message: string): NextResponse {
  return NextResponse.json({ code: "UNAUTHORIZED", message }, { status: 403 });
}

// Every brain_* row carries project_id; the enable-gate refuses recall/retain on
// a project whose Brain is off.
async function assertBrainEnabled(db: Db, projectId: string): Promise<void> {
  const r = await db.execute(
    sql`SELECT brain_enabled FROM projects WHERE id = ${projectId}`,
  );

  if (!r.rows[0]?.brain_enabled) {
    throw new MaisterError(
      "CONFIG",
      "Project Brain is not enabled for this project",
    );
  }
}

// For an agent token, the per-link axis must allow the operation. Scope +
// project-role alone never suffice (Q5 / memory-poisoning guard).
async function agentAxisAllows(
  db: Db,
  actor: TokenActor,
  projectId: string,
  axis: "read" | "write",
): Promise<boolean> {
  if (actor.tokenKind !== "agent" || !actor.agentId) return true;

  const r = await db.execute(
    axis === "read"
      ? sql`SELECT can_read_brain AS allowed FROM agent_project_links WHERE agent_id = ${actor.agentId} AND project_id = ${projectId}`
      : sql`SELECT can_write_brain AS allowed FROM agent_project_links WHERE agent_id = ${actor.agentId} AND project_id = ${projectId}`,
  );

  return Boolean(r.rows[0]?.allowed);
}

function snapshotActor(actor: TokenActor): {
  actorType: "user" | "agent" | "system";
  actorId: string;
} {
  if (actor.tokenKind === "agent") {
    return { actorType: "agent", actorId: actor.agentId ?? actor.tokenId };
  }
  if (actor.tokenKind === "user") {
    return { actorType: "user", actorId: actor.ownerUserId ?? actor.tokenId };
  }

  return { actorType: "system", actorId: actor.tokenId };
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "memory:read",
      endpoint: ENDPOINT_GET,
      method: "GET",
      db,
    },
    async (ctx: ExtCtx) => {
      try {
        await assertBrainEnabled(db, ctx.projectId);

        if (!(await agentAxisAllows(db, ctx.actor, ctx.projectId, "read"))) {
          return forbidden("agent token lacks can_read_brain for this project");
        }

        const url = req.nextUrl;
        const q = url.searchParams.get("q");

        if (!q || q.trim().length === 0) {
          throw new MaisterError("CONFIG", "query parameter `q` is required");
        }

        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;

        if (
          limit !== undefined &&
          (!Number.isInteger(limit) || limit < 1 || limit > 50)
        ) {
          throw new MaisterError(
            "CONFIG",
            "`limit` must be an integer in 1..50",
          );
        }

        const kinds = url.searchParams
          .getAll("kinds")
          .filter((k): k is BrainItemKind =>
            (KINDS as readonly string[]).includes(k),
          );
        const minRaw = url.searchParams.get("minConfidence");
        const minConfidence = minRaw != null ? Number(minRaw) : undefined;

        if (
          minConfidence !== undefined &&
          (!Number.isFinite(minConfidence) ||
            minConfidence < 0 ||
            minConfidence > 1)
        ) {
          throw new MaisterError(
            "CONFIG",
            "`minConfidence` must be a number in 0..1",
          );
        }

        const client = await getBrainEmbeddingClient(db);
        const items = await recall(ctx.projectId, q, {
          db,
          client,
          limit,
          kinds: kinds.length > 0 ? kinds : undefined,
          minConfidence,
        });

        const { actorType, actorId } = snapshotActor(ctx.actor);

        await writeBrainSnapshot(db, {
          projectId: ctx.projectId,
          runId: null,
          actorType,
          actorId,
          trigger: "explicit",
          query: q,
          embeddingModel: client.model,
          returnedItems: items.map((i) => ({ itemId: i.id, score: i.score })),
          rankerVersion: RANKER_VERSION,
        });

        return NextResponse.json(
          {
            items: items.map((i) => ({
              id: i.id,
              kind: i.kind,
              title: i.title,
              content: i.content,
              confidence: i.confidence,
              score: i.score,
              tags: i.tags,
              createdAt: i.createdAt,
              expiresAt: i.expiresAt,
              provenance: {
                runId: i.provenance.runId,
                gateKind: i.provenance.gateKind,
              },
            })),
          },
          { status: 200 },
        );
      } catch (err) {
        return extError(err);
      }
    },
  );
}

const retainBodySchema = z
  .object({
    content: z.string().min(1),
    kind: z.enum(KINDS),
    title: z.string().min(1).max(512).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;
  const db = getDb() as Db;

  return handleExt(
    req,
    {
      slug,
      scopeLabel: "memory:write",
      endpoint: ENDPOINT_POST,
      method: "POST",
      db,
    },
    async (ctx: ExtCtx) => {
      try {
        await assertBrainEnabled(db, ctx.projectId);

        if (!(await agentAxisAllows(db, ctx.actor, ctx.projectId, "write"))) {
          return forbidden(
            "agent token lacks can_write_brain for this project",
          );
        }

        let body: unknown;

        try {
          body = await req.json();
        } catch {
          throw new MaisterError("CONFIG", "invalid JSON body");
        }

        const parsed = retainBodySchema.safeParse(body);

        if (!parsed.success) {
          throw new MaisterError(
            "CONFIG",
            parsed.error.issues[0]?.message ?? "invalid body",
          );
        }

        const result = await retain(
          ctx.projectId,
          {
            kind: parsed.data.kind,
            content: parsed.data.content,
            title: parsed.data.title,
            tags: parsed.data.tags,
          },
          {},
          { db },
        );

        return NextResponse.json(
          {
            reinforced: result.reinforced,
            item: {
              id: result.itemId,
              kind: parsed.data.kind,
              status: "active",
            },
          },
          { status: 200 },
        );
      } catch (err) {
        return extError(err);
      }
    },
  );
}
