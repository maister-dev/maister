import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  agentDefinitionBodySchema,
  agentsErrorResponse,
  projectAgentSummary,
} from "@/lib/agents/admin-shared";
import { createAgent, listAgents } from "@/lib/agents/registry";
import { requireGlobalRole } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

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

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const rows = await listAgents();

    return NextResponse.json({ agents: rows.map(projectAgentSummary) });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const parsed = agentDefinitionBodySchema.safeParse(await parseJson(req));

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const created = await createAgent({
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.description,
      scope: parsed.data.scope,
      project: parsed.data.project ?? null,
      runner: parsed.data.runner ?? null,
      workspace: parsed.data.workspace,
      mode: parsed.data.mode,
      triggers: parsed.data.triggers,
      capabilityProfile: parsed.data.capabilityProfile ?? null,
      riskTier: parsed.data.riskTier,
      prompt: parsed.data.prompt,
    });

    return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
