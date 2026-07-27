import "server-only";

import type { ExtCtx } from "@/lib/tokens/ext-handler";
import type { TokenActor } from "@/lib/tokens/verify";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  readAgentMemoryRaw,
  writeAgentMemoryCas,
  type AgentMemoryState,
} from "@/lib/agents/memory-store";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { agentMemoryMaxChars } from "@/lib/instance-config";
import { handleExt, httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agentProjectLinks, projects } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep — the ext db handle is untyped upstream.

type Db = any;

const ENDPOINT_GET = "GET /api/v1/ext/agent/memory";
const ENDPOINT_POST = "POST /api/v1/ext/agent/memory";
const SCOPE = "agent_memory:write";

const log = pino({
  name: "ext-agent-memory-route",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-152 D15: `content` and `ifHash` are PAYLOAD, never locators — neither
// reaches a path or a cross-resource lookup. There is no `slug`, no `agentId`
// and no `runId` in the body; every identifier is auth-context or server-state.
const bodySchema = z
  .object({
    content: z.string(),
    ifHash: z.string().min(1).nullable().optional(),
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

// One refusal shape for every authorization axis. The body NEVER reveals which
// axis failed — an agent learning "the flag is off" vs "you are detached" is
// information it has no use for and a probe surface we need not offer.
function forbidden(): NextResponse {
  return NextResponse.json(
    { code: "UNAUTHORIZED", message: "agent memory is not available" },
    { status: 403 },
  );
}

function serialize(state: AgentMemoryState) {
  return {
    content: state.content,
    hash: state.hash,
    sizeChars: state.sizeChars,
    updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
  };
}

// Resolves the (agentId, projectSlug) pair this token may act on, or null when
// ANY axis refuses. Fails closed on a malformed agent token: the DB CHECK forces
// agent_id NOT NULL for agent-kind tokens today, but this must not silently open
// if that invariant is ever relaxed.
async function resolveAgentMemoryTarget(
  db: Db,
  actor: TokenActor,
  projectId: string,
): Promise<{ agentId: string; projectSlug: string } | null> {
  if (actor.tokenKind !== "agent" || !actor.agentId) return null;

  const links = await db
    .select({ memoryEnabled: agentProjectLinks.memoryEnabled })
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, actor.agentId),
        eq(agentProjectLinks.projectId, projectId),
      ),
    );

  // Detached (no row) and disabled (flag false) are the same refusal: both mean
  // "memory is inert for this attachment". The FILE is untouched either way.
  if (links[0]?.memoryEnabled !== true) return null;

  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId));
  const slug = rows[0]?.slug as string | undefined;

  if (!slug) return null;

  return { agentId: actor.agentId, projectSlug: slug };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    { scopeLabel: SCOPE, endpoint: ENDPOINT_GET, method: "GET", db },
    async (ctx: ExtCtx) => {
      try {
        const target = await resolveAgentMemoryTarget(
          db,
          ctx.actor,
          ctx.projectId,
        );

        if (!target) return forbidden();

        const state = await readAgentMemoryRaw(
          target.projectSlug,
          target.agentId,
        );

        // An absent file is NOT a 404 — it is the first-writer state, and
        // reporting it as one would make `ifHash: null` look like a workaround
        // rather than the contract.
        return NextResponse.json(serialize(state), { status: 200 });
      } catch (err) {
        return extError(err);
      }
    },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const db = getDb();

  return handleExt(
    req,
    { scopeLabel: SCOPE, endpoint: ENDPOINT_POST, method: "POST", db },
    async (ctx: ExtCtx) => {
      try {
        const target = await resolveAgentMemoryTarget(
          db,
          ctx.actor,
          ctx.projectId,
        );

        if (!target) return forbidden();

        // Parse JSON as its own step so a malformed body maps to the documented
        // 422 CONFIG family rather than an unhandled throw.
        let raw: unknown;

        try {
          raw = await req.json();
        } catch (err) {
          throw new MaisterError(
            "CONFIG",
            `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const parsed = bodySchema.safeParse(raw);

        if (!parsed.success) {
          throw new MaisterError(
            "CONFIG",
            `invalid body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          );
        }

        const max = agentMemoryMaxChars();

        if (parsed.data.content.length > max) {
          throw new MaisterError(
            "CONFIG",
            `agent memory: content is ${parsed.data.content.length} characters, over the ${max}-character cap`,
          );
        }

        const result = await writeAgentMemoryCas(
          target.projectSlug,
          target.agentId,
          parsed.data.content,
          parsed.data.ifHash ?? null,
        );

        if (!result.ok) {
          // The current state rides the 409 so the caller can merge and retry
          // rather than clobber — the whole point of the CAS.
          return NextResponse.json(
            {
              code: "CONFLICT",
              message:
                "agent memory: ifHash does not match the current file — merge the returned content and retry",
              current: serialize(result.current),
            },
            { status: 409 },
          );
        }

        log.debug(
          {
            agentId: target.agentId,
            projectId: ctx.projectId,
            // Server-derived from the token name (`agent-run:<id>`), never a
            // body field — log/audit only.
            runId: ctx.actor.boundRunId,
            sizeChars: parsed.data.content.length,
            priorHash: parsed.data.ifHash ?? null,
            newHash: result.hash,
          },
          "[ext.agent-memory] written",
        );

        const state = await readAgentMemoryRaw(
          target.projectSlug,
          target.agentId,
        );

        return NextResponse.json(serialize(state), { status: 200 });
      } catch (err) {
        return extError(err);
      }
    },
  );
}
