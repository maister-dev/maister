import "server-only";

import type { BrainProposalActor } from "@/lib/brain/schema";
import type { ExtCtx } from "@/lib/tokens/ext-handler";
import type { TokenActor } from "@/lib/tokens/verify";

import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  assertBrainProvisioned,
  assertProjectBrainEnabled,
} from "@/lib/brain/guard";
import { createBrainProposal } from "@/lib/brain/proposals";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  handleExt,
  httpStatusForExtCode,
  recordRequiredTokenAudit,
} from "@/lib/tokens/ext-handler";

const ENDPOINT_POST =
  "POST /api/v1/ext/projects/[slug]/memory/proposals";
const PROPOSAL_KINDS = [
  "rule",
  "skill",
  "flow",
  "adr",
  "roadmap",
  "state",
] as const;
const BLAST_RADII = ["low", "medium", "high"] as const;

type RouteParams = { params: Promise<{ slug: string }> };

// FIXME(any): dual drizzle-orm peer-dep — the ext db handle is untyped upstream.
type Db = any;

const proposalBodySchema = z
  .object({
    kind: z.enum(PROPOSAL_KINDS),
    evidenceItemIds: z.array(z.string().min(1)).default([]),
    draft: z.record(z.string(), z.unknown()),
    blastRadius: z.enum(BLAST_RADII).default("medium"),
    clusterHash: z.string().min(1).nullable().optional(),
    rationale: z.string().max(4000).optional(),
  })
  .strict();

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
    SELECT can_write_brain AS allowed
    FROM agent_project_links
    WHERE agent_id = ${actor.agentId} AND project_id = ${projectId}
  `);

  return Boolean(r.rows[0]?.allowed);
}

function proposalActor(actor: TokenActor): BrainProposalActor {
  if (actor.tokenKind === "agent") {
    return { type: "agent", id: actor.agentId ?? actor.tokenId };
  }

  if (actor.tokenKind === "user") {
    return { type: "user", id: actor.ownerUserId ?? actor.tokenId };
  }

  return { type: "system", id: actor.tokenId };
}

function proposalDraft(input: z.infer<typeof proposalBodySchema>): Record<string, unknown> {
  if (input.rationale === undefined) return input.draft;

  return { ...input.draft, rationale: input.rationale };
}

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
      successAuditInWork: true,
    },
    async (ctx: ExtCtx) => {
      try {
        assertBrainProvisioned();
        await assertProjectBrainEnabled(db, ctx.projectId);

        if (!(await agentAxisAllows(db, ctx.actor, ctx.projectId))) {
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

        const parsed = proposalBodySchema.safeParse(body);

        if (!parsed.success) {
          throw new MaisterError(
            "CONFIG",
            parsed.error.issues[0]?.message ?? "invalid body",
          );
        }

        const proposal = await db.transaction(async (tx: Db) => {
          const created = await createBrainProposal(tx, {
            projectId: ctx.projectId,
            kind: parsed.data.kind,
            evidenceItemIds: parsed.data.evidenceItemIds,
            draft: proposalDraft(parsed.data),
            blastRadius: parsed.data.blastRadius,
            autonomyDecision: "manual",
            clusterHash: parsed.data.clusterHash ?? null,
            actor: proposalActor(ctx.actor),
          });
          const statusCode = created.idempotent ? 200 : 201;

          await recordRequiredTokenAudit(
            {
              tokenId: ctx.actor.tokenId,
              projectId: ctx.projectId,
              actorLabel: ctx.actor.actorLabel,
              scopeUsed: "memory:write",
              endpoint: ENDPOINT_POST,
              method: "POST",
              result: "ok",
              statusCode,
            },
            tx,
          );

          return created;
        });

        return NextResponse.json(
          {
            proposalId: proposal.id,
            status: "pending",
            idempotent: proposal.idempotent,
          },
          { status: proposal.idempotent ? 200 : 201 },
        );
      } catch (err) {
        return extError(err);
      }
    },
  );
}
