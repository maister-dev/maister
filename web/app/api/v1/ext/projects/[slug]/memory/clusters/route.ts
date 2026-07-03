import "server-only";

import type { ExtCtx } from "@/lib/tokens/ext-handler";
import type { TokenActor } from "@/lib/tokens/verify";

import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

import {
  assertBrainProvisioned,
  assertProjectBrainEnabled,
} from "@/lib/brain/guard";
import { listMemoryClusters } from "@/lib/brain/clusters";
import { getBrainEmbeddingClient } from "@/lib/brain/openai-compatible";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

const ENDPOINT_GET =
  "GET /api/v1/ext/projects/[slug]/memory/clusters";
const KINDS = ["lesson", "observation", "state_fact"] as const;

type RouteParams = { params: Promise<{ slug: string }> };

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

async function agentAxisAllows(
  db: Db,
  actor: TokenActor,
  projectId: string,
): Promise<boolean> {
  if (actor.tokenKind !== "agent") return true;
  if (!actor.agentId) return false;

  const r = await db.execute(sql`
    SELECT can_read_brain AS allowed
    FROM agent_project_links
    WHERE agent_id = ${actor.agentId} AND project_id = ${projectId}
  `);

  return Boolean(r.rows[0]?.allowed);
}

function readIntParam(
  url: URL,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = url.searchParams.get(name);

  if (raw === null) return undefined;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MaisterError("CONFIG", `\`${name}\` must be an integer in ${min}..${max}`);
  }

  return value;
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
        assertBrainProvisioned();
        await assertProjectBrainEnabled(db, ctx.projectId);

        if (!(await agentAxisAllows(db, ctx.actor, ctx.projectId))) {
          return forbidden("agent token lacks can_read_brain for this project");
        }

        const url = req.nextUrl;
        const kindsRaw = url.searchParams.getAll("kinds");
        const unknownKinds = kindsRaw.filter(
          (kind) => !(KINDS as readonly string[]).includes(kind),
        );

        if (unknownKinds.length > 0) {
          throw new MaisterError(
            "CONFIG",
            `unknown \`kinds\` value(s): ${unknownKinds.join(", ")} (expected ${KINDS.join(" | ")})`,
          );
        }

        const client = await getBrainEmbeddingClient(db);
        const clusters = await listMemoryClusters(db, {
          projectId: ctx.projectId,
          client,
          kinds: kindsRaw.length > 0 ? (kindsRaw as typeof KINDS[number][]) : undefined,
          minRecurrence: readIntParam(url, "minRecurrence", 2, 20),
          limit: readIntParam(url, "limit", 1, 50),
        });

        return NextResponse.json({ clusters }, { status: 200 });
      } catch (err) {
        return extError(err);
      }
    },
  );
}
