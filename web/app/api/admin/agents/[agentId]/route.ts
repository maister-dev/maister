import "server-only";

import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  agentsErrorResponse,
  projectAgentSummary,
} from "@/lib/agents/admin-shared";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { setAgentEnabled, unquarantineAgent } from "@/lib/agents/registry";
import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents } = schemaModule as unknown as Record<string, any>;

// ADR-089 rework: definitions change only through their providing flow
// package — this route keeps the platform kill-switches (enabled,
// un-quarantine) and the read; create/edit/delete endpoints are gone.
const patchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    unquarantine: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.unquarantine !== undefined, {
    message: "at least one of enabled/unquarantine is required",
  });

type RouteContext = { params: Promise<{ agentId: string }> };

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Single-agent read — the DB row plus the .md body (the prompt lives only in
// the canonical definition file inside the installed package revision).
export async function GET(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { agentId: rawAgentId } = await ctx.params;
    // Qualified ids carry a `:`; route params arrive URL-encoded.
    const agentId = decodeURIComponent(rawAgentId);
    const db = getDb() as unknown as { select: any };
    const rows = await db.select().from(agents).where(eq(agents.id, agentId));
    const row = rows[0];

    if (!row) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `agent not found: ${agentId}` },
        { status: 404 },
      );
    }

    let prompt = "";

    try {
      const raw = await readFile(row.sourcePath as string, "utf8");

      prompt = parseAgentDefinition(agentId, raw).prompt.trim();
    } catch {
      // A missing/invalid file still returns the row — the catalog shows an
      // empty prompt and the resync surface reports the drift.
    }

    return NextResponse.json({ agent: projectAgentSummary(row), prompt });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { agentId: rawAgentId } = await ctx.params;
    const agentId = decodeURIComponent(rawAgentId);
    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    if (parsed.data.enabled !== undefined) {
      await setAgentEnabled(agentId, parsed.data.enabled);
    }

    if (parsed.data.unquarantine === true) {
      await unquarantineAgent(agentId);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
