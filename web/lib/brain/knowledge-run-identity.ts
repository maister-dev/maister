import "server-only";

import type {
  KnowledgePrincipalIdentity,
  KnowledgeTransaction,
} from "./knowledge-access";
import type { NativeKnowledgeActor } from "@/lib/company/types";

import { sql } from "drizzle-orm";

import { resolveKnowledgePrincipal } from "./knowledge-access";
import { currentKnowledgeNodeAttemptPolicy } from "./knowledge-node-policy";

import { requireCompanyKnowledgeRunOwner } from "@/lib/agents/company-run-credential-owner";
import { nativeKnowledgeActorSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

export type KnowledgeRunIdentity = Readonly<{
  identity: Exclude<KnowledgePrincipalIdentity, { kind: "user" }>;
  runKind: "agent" | "flow";
}>;

function launchRole(
  run: Readonly<Record<string, unknown>>,
): NativeKnowledgeActor {
  const activity = run.agent_activity_snapshot as Readonly<
    Record<string, unknown>
  > | null;

  if (activity?.version !== 1 || activity.agentId !== run.source_agent_id)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The execution has no immutable professional role identity",
    );
  const actor = nativeKnowledgeActorSchema.safeParse({
    schemaVersion: 1,
    agentId: activity.agentId,
    packageInstallId: activity.packageInstallId,
    packageName: activity.packageName,
    definitionSha256: activity.definitionSha256,
  });

  if (!actor.success)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The execution's immutable role/package identity is unavailable",
    );

  return actor.data;
}

/** Resolve a read inspector or credential to current policy without fabricating an API credential. */
export async function resolveKnowledgeRunIdentity(
  tx: KnowledgeTransaction,
  runId: string,
  nodeAttemptId: string | null,
): Promise<KnowledgeRunIdentity> {
  const run = (
    await tx.execute(
      sql`SELECT id,run_kind,project_id,company_id,source_agent_id,agent_activity_snapshot,current_step_id,result_contract FROM runs WHERE id=${runId} AND status IN ('Pending','Running','NeedsInput','NeedsInputIdle','WaitingOnChildren','Review') FOR SHARE`,
    )
  ).rows[0];

  if (!run || (run.run_kind !== "agent" && run.run_kind !== "flow"))
    throw new MaisterError(
      "UNAUTHORIZED",
      "An active specialist execution is required",
    );
  if (typeof run.company_id === "string") {
    if (
      run.run_kind !== "agent" ||
      run.project_id !== null ||
      nodeAttemptId !== null
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "A company agent inspection must identify its exact standalone execution",
      );
    const owner = await requireCompanyKnowledgeRunOwner(tx, runId);
    const role = launchRole(run);

    if (
      role.agentId !== owner.professionalRole.agentId ||
      role.packageInstallId !== owner.professionalRole.packageInstallId ||
      role.packageName !== owner.professionalRole.packageName ||
      role.definitionSha256 !== owner.professionalRole.definitionSha256
    )
      throw new MaisterError(
        "UNAUTHORIZED",
        "Company execution role attribution does not match its exact reviewed configuration",
      );
    const initiator = await resolveKnowledgePrincipal(
      tx,
      { kind: "user", userId: owner.userId },
      "knowledge:read",
    );

    if (initiator.kind !== "user")
      throw new MaisterError(
        "UNAUTHORIZED",
        "A current initiating company principal is required",
      );

    return {
      runKind: "agent",
      identity: {
        kind: "company_agent",
        actor: { kind: "agent", id: owner.agentId, runId, attemptId: null },
        companyId: owner.companyId,
        bindingId: owner.snapshot.specialistBinding.id,
        initiatingUser: initiator.user,
        actionLimits: owner.actionLimits,
        execution: owner.snapshot,
      },
    };
  }
  if (typeof run.project_id !== "string")
    throw new MaisterError(
      "UNAUTHORIZED",
      "An active bound specialist execution is required",
    );
  const nativeResult =
    (run.result_contract as { nativeContract?: unknown } | null)
      ?.nativeContract === FINDINGS_CONTRACT;
  let node: Readonly<Record<string, unknown>> | undefined;

  if (nodeAttemptId !== null) {
    if (run.run_kind !== "flow")
      throw new MaisterError(
        "UNAUTHORIZED",
        "A node inspection must identify its owning Flow execution",
      );
    node = (
      await tx.execute(
        sql`SELECT node.id,node.knowledge_actor FROM node_attempts node WHERE node.id=${nodeAttemptId} AND ${currentKnowledgeNodeAttemptPolicy("node", sql`${runId}`, sql`${run.current_step_id}`)} FOR SHARE`,
      )
    ).rows[0];
    if (!node)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The inspected node attempt is no longer current",
      );
  } else if (run.run_kind === "flow" && nativeResult)
    throw new MaisterError(
      "UNAUTHORIZED",
      "A native Flow inspection requires an exact current node attempt",
    );
  let actor: NativeKnowledgeActor;

  if (node?.knowledge_actor !== null && node?.knowledge_actor !== undefined) {
    const recorded = nativeKnowledgeActorSchema.safeParse(node.knowledge_actor);

    if (!recorded.success)
      throw new MaisterError(
        "CONFIG",
        "Stored node role attribution is invalid",
      );
    actor = recorded.data;
  } else actor = launchRole(run);
  const binding = (
    await tx.execute(sql`
    SELECT l.id,l.can_read_brain,l.can_write_brain FROM agent_project_links l
    JOIN agents a ON a.id=l.agent_id
    JOIN project_package_attachments pa ON pa.project_id=l.project_id AND pa.package_name=a.package_name
    JOIN package_installs current_pin ON current_pin.id=pa.package_install_id
    JOIN package_installs frozen_pin ON frozen_pin.id=${actor.packageInstallId} AND frozen_pin.name=a.package_name
    WHERE l.agent_id=${actor.agentId} AND a.package_name=${actor.packageName} AND l.project_id=${run.project_id} AND l.enabled AND a.enabled AND a.quarantined_at IS NULL
      AND current_pin.package_status='Installed' AND current_pin.trust_status IN ('trusted','trusted_by_policy')
      AND frozen_pin.package_status='Installed' AND frozen_pin.trust_status IN ('trusted','trusted_by_policy')
    FOR SHARE OF l,a,pa,current_pin,frozen_pin
  `)
  ).rows[0];

  if (!binding)
    throw new MaisterError(
      "UNAUTHORIZED",
      "The current specialist knowledge binding is unavailable",
    );

  return {
    runKind: run.run_kind,
    identity: {
      kind: "agent",
      actor: {
        kind: "agent",
        id: actor.agentId,
        runId,
        attemptId: nodeAttemptId,
      },
      projectId: run.project_id,
      bindingId: String(binding.id),
      canReadBrain: binding.can_read_brain === true,
      canWriteBrain: binding.can_write_brain === true,
    },
  };
}
