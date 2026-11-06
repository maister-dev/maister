import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { SupervisorDiagnosticsStatus } from "@/lib/execution-host";
import type { CompanyCapabilityProfile } from "@/lib/capabilities/types";
import type { CapabilityAgent } from "@/lib/config.schema";
import type { MaterializationPlan } from "@/lib/db/schema";
import type { SessionEnforcementProfile } from "@/lib/flows/enforcement-profile";
import type { MaterializedCapabilityProfile } from "@/lib/capabilities/materialize";

import pino from "pino";

import { loadCompanyFlowSessionContext } from "./company-flow-session-context";
import { resolveCompanyFlowNodeEnforcement } from "./company-flow-enforcement";
import { companyAgentWorkdirPath } from "./workspace-paths";

import { materializeCapabilityProfile } from "@/lib/capabilities/materialize";
import { assertCapabilityGuardEvidence } from "@/lib/flows/enforcement-evidence";
import { foldEnforcementProfileIntoDigest } from "@/lib/flows/enforcement-profile";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";

const log = pino({
  name: "agents:company-flow-materialization",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyFlowMaterialization = {
  capabilityProfilePath: string;
  capabilityInstructionsPath: string;
  adapterLaunch: MaterializedCapabilityProfile["adapterLaunch"];
  mcpServers: MaterializedCapabilityProfile["mcpServers"];
  plan: MaterializationPlan;
  enforcementProfile: SessionEnforcementProfile;
};

/** Materialize an attested node through the existing file leases, never a project capability catalog. */
export async function materializeCompanyFlowNodeCapabilities(args: {
  db: Db;
  runId: string;
  nodeAttemptId: string;
  sessionName: string;
  worktreePath: string;
  checkDiagnostics?: () => Promise<SupervisorDiagnosticsStatus>;
}): Promise<CompanyFlowMaterialization> {
  const current = await args.db.transaction(async (tx) => {
    const context = await loadCompanyFlowSessionContext(tx, args.runId);
    const session = context.sessions.find(
      (entry) => entry.sessionName === args.sessionName,
    );
    const node = compileManifest(context.manifest).nodes.get(
      context.run.currentStepId ?? "",
    );

    if (
      !session ||
      !node ||
      (node.nodeType !== "ai_coding" && node.nodeType !== "orchestrator") ||
      (node.session ?? "default") !== args.sessionName
    )
      throw new MaisterError(
        "CONFIG",
        "Company node capability materialization requires its exact frozen session",
      );
    if (
      args.worktreePath !==
      companyAgentWorkdirPath(context.run.companyId, args.runId)
    )
      throw new MaisterError(
        "PRECONDITION",
        "Company capability materialization requires its managed owner/run directory",
      );
    const enforcementProfile = await resolveCompanyFlowNodeEnforcement(
      tx,
      args.runId,
      args.nodeAttemptId,
    );

    return {
      companyId: context.run.companyId,
      runner: session.runnerSnapshot,
      enforcementProfile,
    };
  });
  const agent = current.runner.capabilityAgent as CapabilityAgent;

  await assertCapabilityGuardEvidence({
    agent,
    permissionPolicy: current.runner.permissionPolicy,
    checkDiagnostics: args.checkDiagnostics,
  });
  const withoutDigest: Omit<CompanyCapabilityProfile, "profileDigest"> = {
    projectId: null,
    owner: { kind: "company", companyId: current.companyId },
    executorAgent: agent,
    planMode: "off",
    workMode: "auto",
    reasoningEffort: "high",
    selectedMcpIds: [],
    selectedSkillIds: [],
    selectedRuleIds: [],
    selectedAgentDefinitionIds: [],
    selectedRestrictionIds: [],
    enforced: [],
    instructed: [],
    supported: [],
    unsupported: [],
    refused: [],
    downgraded: [],
  };
  const profile: CompanyCapabilityProfile = {
    ...withoutDigest,
    profileDigest: foldEnforcementProfileIntoDigest(
      contentDigest(withoutDigest),
      current.enforcementProfile,
    ),
  };
  const materialized = await materializeCapabilityProfile({
    runId: args.runId,
    nodeAttemptId: args.nodeAttemptId,
    worktreePath: args.worktreePath,
    profile,
    permissionMode: "ask",
    executor: {
      executorRefId: current.runner.id,
      agent,
      model: current.runner.model,
    },
  });
  const plan: MaterializationPlan = {
    profileDigest: profile.profileDigest,
    resolvedRevisions: [],
    materializedFiles: materialized.materializedFiles,
    enforcedClasses: [...current.enforcementProfile.enforcedClasses],
    instructedClasses: [],
    refusedClasses: [],
    withheldMcps: [],
    enforcementProfile: current.enforcementProfile,
    cleanup: { status: "pending" },
  };

  log.debug(
    {
      runId: args.runId,
      nodeAttemptId: args.nodeAttemptId,
      companyId: current.companyId,
      sessionName: args.sessionName,
      profileDigest: profile.profileDigest,
      allowedToolCount: current.enforcementProfile.tools?.allow.length ?? 0,
    },
    "native company capability profile materialized",
  );

  return {
    capabilityProfilePath: materialized.profilePath,
    capabilityInstructionsPath: materialized.instructionsPath,
    adapterLaunch: materialized.adapterLaunch,
    mcpServers: materialized.mcpServers,
    plan,
    enforcementProfile: current.enforcementProfile,
  };
}
