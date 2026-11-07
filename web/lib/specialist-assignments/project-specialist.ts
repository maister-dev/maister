import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ProjectAgentTriggerClaim } from "@/lib/agents/trigger-attempts";

import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";

/** The effective project pin chooses native admission; another catalog revision cannot change that decision. */
export async function isNativeProjectSpecialist(
  db: Db,
  claim: ProjectAgentTriggerClaim,
): Promise<boolean> {
  const effective = await resolveEffectiveAgentDefinition(
    { projectId: claim.projectId, agentId: claim.sourceAgentId },
    db,
  );

  return effective.parsed.specialist != null;
}
