import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { SessionEnforcementProfile } from "@/lib/flows/enforcement-profile";

import pino from "pino";

import { companyFlowEnforcementProfile } from "../../../runtime/company-flow-tools";

import {
  requireCompanyRunCredentialOwner,
  requireCompanyFlowNodeKnowledgeOwner,
} from "./company-run-credential-owner";

const log = pino({
  name: "agents:company-flow-enforcement",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Current attested node limits and the role's native-MCP declaration bound its physical tool surface. */
export async function resolveCompanyFlowNodeEnforcement(
  tx: SqlTransaction,
  runId: string,
  nodeAttemptId: string,
): Promise<SessionEnforcementProfile> {
  const root = await requireCompanyRunCredentialOwner(tx, runId);
  const owner = await requireCompanyFlowNodeKnowledgeOwner(
    tx,
    root,
    nodeAttemptId,
  );
  const scopes = (["knowledge:read", "knowledge:propose"] as const).filter(
    (action) => owner.platformMcp && owner.actionLimits.includes(action),
  );
  const profile = companyFlowEnforcementProfile(scopes);

  log.debug(
    {
      runId,
      nodeAttemptId,
      agentId: owner.agentId,
      bindingId: owner.bindingId,
      scopeCount: scopes.length,
      allowedToolCount: profile.tools.allow.length,
    },
    "current company node MCP-only policy resolved",
  );

  return profile;
}
