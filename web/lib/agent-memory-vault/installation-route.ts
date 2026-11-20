import "server-only";

import type { NextResponse } from "next/server";
import type { PrepareVaultAccess } from "./store";

import { vaultErrorResponse } from "./http";
import { prepareHumanInstallationVault } from "./installation-access";

import { requireActiveSession } from "@/lib/authz";
import { decodeRouteParam } from "@/lib/route-params";

export type InstallationVaultRoute = Readonly<{
  params: Promise<{ specialistId: string; bindingId: string }>;
}>;

export async function withInstallationVault(
  route: InstallationVaultRoute,
  action: "read" | "edit",
  work: (prepare: PrepareVaultAccess, userId: string) => Promise<NextResponse>,
) {
  try {
    const user = await requireActiveSession();
    const { specialistId, bindingId } = await route.params;
    const prepare = prepareHumanInstallationVault({
      userId: user.id,
      action,
      agentId: decodeRouteParam(specialistId, "specialistId"),
      bindingId: decodeRouteParam(bindingId, "bindingId"),
    });

    return await work(prepare, user.id);
  } catch (error) {
    return vaultErrorResponse(error, "installation agent vault");
  }
}
