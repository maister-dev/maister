import "server-only";

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
  const agentId = body.target.agentId;

  if (
    !assignmentWork ||
    !agentId ||
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
      "Company work requires a bounded workspace-none standalone agent request",
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
      const [current] = (
        await tx.execute(sql`
      SELECT id,revision FROM company_specialist_bindings
      WHERE company_id=${companyId} AND agent_id=${agentId} AND enabled AND detached_at IS NULL FOR SHARE
    `)
      ).rows;

      if (
        typeof current?.id !== "string" ||
        typeof current.revision !== "number"
      )
        throw new MaisterError(
          "PRECONDITION",
          "The current company specialist binding is unavailable",
        );
      const { binding, effective } = await prepareCompanySpecialistRole(tx, {
        companyId,
        bindingId: current.id,
        bindingRevision: current.revision,
      });

      assertStandaloneCompanyAgentDefinition(effective.parsed);
      const result = buildOperationalContract(effective);

      return {
        tokenId,
        selector,
        prepared: {
          bounds: DEFAULT_ASSIGNMENT_WORK_BOUNDS,
          sourceRestrictions: [],
          target: {
            kind: "company_agent",
            companyId,
            specialistBinding: {
              id: binding.bindingId,
              revision: binding.revision,
              snapshotSha256: binding.snapshotDigest,
            },
            role: {
              agentId,
              packageInstallId: binding.snapshot.packageInstallId,
              packageRevision: binding.snapshot.packageRevision,
              definitionSha256: agentDefinitionSha256(effective.parsed),
            },
          },
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

  return reserveCompanyDelegatedAgentRun(db, request);
}
