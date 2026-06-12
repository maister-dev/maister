import "server-only";

import { NextResponse } from "next/server";

import {
  agentsErrorResponse,
  projectAgentSummary,
} from "@/lib/agents/admin-shared";
import { listAgents } from "@/lib/agents/registry";
import { requireGlobalRole } from "@/lib/authz";

// ADR-089 rework: the catalog is a projection of installed flow packages —
// agents are created/edited through packages (git push + upgrade, or Studio
// draft→publish), so there is NO create endpoint here.
export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const rows = await listAgents();

    return NextResponse.json({ agents: rows.map(projectAgentSummary) });
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
