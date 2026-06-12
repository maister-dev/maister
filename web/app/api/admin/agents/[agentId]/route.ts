import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  agentDefinitionBodySchema,
  agentsErrorResponse,
} from "@/lib/agents/admin-shared";
import {
  deleteAgent,
  setAgentEnabled,
  unquarantineAgent,
  updateAgentDefinition,
} from "@/lib/agents/registry";
import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

const patchBodySchema = z
  .object({
    definition: agentDefinitionBodySchema.optional(),
    enabled: z.boolean().optional(),
    unquarantine: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.definition !== undefined ||
      v.enabled !== undefined ||
      v.unquarantine !== undefined,
    { message: "at least one of definition/enabled/unquarantine is required" },
  );

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

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { agentId } = await ctx.params;
    const parsed = patchBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    if (parsed.data.definition) {
      // The url-param is the server-trusted identity; a divergent body id is
      // a cross-resource smell and is refused outright.
      if (parsed.data.definition.id !== agentId) {
        throw new MaisterError(
          "CONFIG",
          `definition.id "${parsed.data.definition.id}" does not match the addressed agent "${agentId}"`,
        );
      }

      await updateAgentDefinition({
        id: agentId,
        name: parsed.data.definition.name,
        description: parsed.data.definition.description,
        scope: parsed.data.definition.scope,
        project: parsed.data.definition.project ?? null,
        runner: parsed.data.definition.runner ?? null,
        workspace: parsed.data.definition.workspace,
        mode: parsed.data.definition.mode,
        triggers: parsed.data.definition.triggers,
        capabilityProfile: parsed.data.definition.capabilityProfile ?? null,
        riskTier: parsed.data.definition.riskTier,
        prompt: parsed.data.definition.prompt,
      });
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

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const { agentId } = await ctx.params;

    await deleteAgent(agentId);

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
