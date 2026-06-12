import "server-only";

import { NextResponse } from "next/server";

import { agentsErrorResponse } from "@/lib/agents/admin-shared";
import { resyncAgents } from "@/lib/agents/registry";
import { requireGlobalRole } from "@/lib/authz";

export async function POST(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const summary = await resyncAgents();

    return NextResponse.json(summary);
  } catch (err) {
    return agentsErrorResponse(err);
  }
}
