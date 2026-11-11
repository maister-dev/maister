import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { TokenActor } from "@/lib/tokens/verify";

import { hasProjectCooperationAppointment } from "./appointment";

import { tokenHasScope } from "@/lib/tokens/scopes";

/** An assignment scope reaches only an exact native appointment through the route's native branch. */
export async function cooperationScope(
  db: SqlTransaction,
  actor: TokenActor,
  legacy: "runs:delegate" | "runs:collect",
): Promise<typeof legacy | "assignments:update" | "assignments:read"> {
  const native =
    legacy === "runs:collect" ? "assignments:read" : "assignments:update";

  if (
    actor.companyId !== undefined ||
    (actor.boundRunId &&
      actor.projectId &&
      tokenHasScope(actor.scopes, native) &&
      !tokenHasScope(actor.scopes, legacy) &&
      (await hasProjectCooperationAppointment(
        db,
        actor.boundRunId,
        actor.projectId,
      )))
  )
    return native;

  return legacy;
}
