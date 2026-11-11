import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type { AssignmentWorkTarget } from "./work-types";
import type { RunResultContract } from "@/lib/run-results/types";
import type { Db } from "@/lib/execution-host/db";
import type { DelegateBody } from "@/lib/orchestrator/delegation-request";
import type { DelegatedWorkRequest } from "./delegated-intake";

import { sql } from "drizzle-orm";

import { readAuthorizedAssignmentInput } from "./context";
import {
  authorizeAssignmentDelegation,
  resolveAssignmentContextPrincipal,
} from "./context-access";
import { DEFAULT_ASSIGNMENT_WORK_BOUNDS } from "./work-types";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { prepareCompanySpecialistRole } from "@/lib/agents/company-agent-context";
import { assertStandaloneCompanyAgentDefinition } from "@/lib/agents/company-agent-definition";
import { reserveCompanyDelegatedAgentRun } from "@/lib/agents/company-agent-launch";
import { reserveCompanyDelegatedFlowRun } from "@/lib/agents/company-flow-launch";
import {
  loadReviewedCompanyCoordinator,
  resolveReviewedCompanyFlowSource,
} from "@/lib/agents/company-flow-context";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { MaisterError } from "@/lib/errors";
import { lockDelegationParent } from "@/lib/orchestrator/admission";

/** Derive the exact child target and parent authority from the verified company credential. */
export async function dispatchCompanyAssignmentChild(
  db: Db,
  input: Readonly<{
    body: DelegateBody;
    companyId: string;
    parentRunId: string;
    tokenId: string;
  }>,
): Promise<{ childRunId: string; status: string }> {
  const { body, companyId, parentRunId, tokenId } = input;
  const { assignmentWork } = body;

  if (
    !assignmentWork ||
    body.mode !== "run" ||
    (body.workspace !== undefined && body.workspace !== "none") ||
    body.workspaceMode === "shared" ||
    body.persistent ||
    body.addressableKey ||
    body.runnerOverride ||
    body.resultProfile ||
    body.title ||
    body.prompt.length > 8000
  )
    throw new MaisterError(
      "CONFIG",
      "Company work requires a bounded workspace-none agent or result-only Flow request",
    );

  const request = await db.transaction(
    async (tx): Promise<DelegatedWorkRequest> => {
      await lockDelegationParent(tx, parentRunId);
      const principal = await resolveAssignmentContextPrincipal(
        tx,
        { kind: "token", tokenId },
        "assignments:update",
      );

      if (
        principal.source.kind !== "execution" ||
        principal.source.runId !== parentRunId
      )
        throw new MaisterError(
          "UNAUTHORIZED",
          "Company delegation requires the current originating execution",
        );
      const { selector } = assignmentWork;
      const retained = await readAuthorizedAssignmentInput(
        tx,
        principal.source,
        selector.assignmentId,
        selector.inputRevision,
      );

      await authorizeAssignmentDelegation(
        tx,
        principal,
        { kind: "company", companyId },
        retained.snapshot.authoritySnapshot.executionPolicy,
      );
      const { target, result } = body.target.flowId
        ? await companyFlowWorkTarget(tx, companyId, body.target.flowId)
        : await companyAgentWorkTarget(tx, companyId, body.target.agentId!);

      return {
        tokenId,
        selector,
        prepared: {
          bounds: DEFAULT_ASSIGNMENT_WORK_BOUNDS,
          sourceRestrictions: [],
          target,
          objectiveInput: {
            objective: body.prompt,
            expectedOutcome: assignmentWork.expectedOutcome,
            input: body.prompt,
            targetIds: [],
            inputRefs: [],
            constraints: retained.snapshot.objectiveInput.constraints,
            verification: [
              { kind: "result", referenceId: null, required: true },
            ],
            expectedResult: {
              schemaRef: result.schemaRef,
              schemaVersion: result.schemaVersion,
              sha256: result.sha256,
              required: true,
            },
          },
        },
      };
    },
  );

  return request.prepared.target.kind === "company_flow"
    ? reserveCompanyDelegatedFlowRun(db, request)
    : reserveCompanyDelegatedAgentRun(db, request);
}

type CompanyChildTarget = Readonly<{
  target: Extract<
    AssignmentWorkTarget,
    { kind: "company_agent" | "company_flow" }
  >;
  result: RunResultContract;
}>;

async function companyAgentWorkTarget(
  tx: SqlTransaction,
  companyId: string,
  agentId: string,
): Promise<CompanyChildTarget> {
  const [current] = (
    await tx.execute(sql`
    SELECT id,revision FROM company_specialist_bindings
    WHERE company_id=${companyId} AND agent_id=${agentId} AND enabled AND detached_at IS NULL FOR SHARE
  `)
  ).rows;

  if (typeof current?.id !== "string" || typeof current.revision !== "number")
    throw new MaisterError(
      "PRECONDITION",
      "The current company specialist binding is unavailable",
    );

  const prepared = await prepareCompanySpecialistRole(tx, {
    companyId,
    bindingId: current.id,
    bindingRevision: current.revision,
  });

  assertStandaloneCompanyAgentDefinition(prepared.effective.parsed);

  return {
    target: {
      kind: "company_agent",
      companyId,
      ...companyWorkRolePins(prepared),
    },
    result: buildOperationalContract(prepared.effective),
  };
}

async function companyFlowWorkTarget(
  tx: SqlTransaction,
  companyId: string,
  flowId: string,
): Promise<CompanyChildTarget> {
  const [current] = (
    await tx.execute(sql`
    SELECT coordinator.id,coordinator.revision,binding.id AS binding_id,binding.revision AS binding_revision
    FROM company_flow_bindings coordinator
    JOIN company_specialist_bindings binding ON binding.id=coordinator.specialist_binding_id
    WHERE coordinator.company_id=${companyId} AND coordinator.flow_ref_id=${flowId}
      AND coordinator.enabled AND coordinator.detached_at IS NULL FOR SHARE OF coordinator,binding
  `)
  ).rows;

  if (
    typeof current?.id !== "string" ||
    typeof current.revision !== "number" ||
    typeof current.binding_id !== "string" ||
    typeof current.binding_revision !== "number"
  )
    throw new MaisterError(
      "PRECONDITION",
      "The current reviewed company Flow is unavailable",
    );
  const roleInput = {
    companyId,
    bindingId: current.binding_id,
    bindingRevision: current.binding_revision,
  };
  const coordinator = await loadReviewedCompanyCoordinator(tx, {
    ...roleInput,
    coordinatorBindingId: current.id,
    coordinatorBindingRevision: current.revision,
  });
  const prepared = await prepareCompanySpecialistRole(tx, roleInput);
  const owner = { kind: "company" as const, companyId };
  const { resultContract } = await resolveReviewedCompanyFlowSource(
    tx,
    { ...prepared, owner },
    coordinator,
  );

  return {
    target: {
      kind: "company_flow",
      companyId,
      ...companyWorkRolePins(prepared),
      coordinatorBinding: {
        id: coordinator.bindingId,
        revision: coordinator.revision,
        snapshotSha256: coordinator.snapshotDigest,
      },
      flow: {
        flowRefId: coordinator.snapshot.flowRefId,
        flowRevisionId: coordinator.snapshot.flowRevisionId,
        resolvedRevision: coordinator.snapshot.packageRevision,
        manifestSha256: coordinator.snapshot.manifestSha256,
      },
    },
    result: resultContract,
  };
}

function companyWorkRolePins({
  binding,
  effective,
}: Awaited<ReturnType<typeof prepareCompanySpecialistRole>>) {
  return {
    specialistBinding: {
      id: binding.bindingId,
      revision: binding.revision,
      snapshotSha256: binding.snapshotDigest,
    },
    role: {
      agentId: binding.snapshot.agentId,
      packageInstallId: binding.snapshot.packageInstallId,
      packageRevision: binding.snapshot.packageRevision,
      definitionSha256: agentDefinitionSha256(effective.parsed),
    },
  };
}
