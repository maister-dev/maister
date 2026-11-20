import "server-only";

import type { NextResponse } from "next/server";
import type { PrepareVaultAccess } from "./store";

import { vaultErrorResponse } from "./http";
import { prepareHumanProjectVault } from "./project-access";

import { requireActiveSession } from "@/lib/authz";
import { decodeRouteParam } from "@/lib/route-params";

export type ProjectVaultRoute = Readonly<{
  params: Promise<{ slug: string; agentId: string }>;
}>;

export async function withProjectVault(
  route: ProjectVaultRoute,
  action: "readRepoFiles" | "editSettings",
  work: (prepare: PrepareVaultAccess) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { slug, agentId } = await route.params;

    return await work(
      prepareHumanProjectVault({
        userId: user.id,
        slug,
        agentId: decodeRouteParam(agentId, "agentId"),
        action,
      }),
    );
  } catch (error) {
    return vaultErrorResponse(error, "project agent vault");
  }
}
