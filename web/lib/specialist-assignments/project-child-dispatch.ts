import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { DelegateBody } from "@/lib/orchestrator/delegation-request";
import type { DelegatedWorkRequest } from "./delegated-intake";

import { eq, sql } from "drizzle-orm";

import { retainDelegatedWorkInTransaction } from "./delegated-intake";
import { DEFAULT_ASSIGNMENT_WORK_BOUNDS } from "./work-types";

import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { resolveAgentConfig } from "@/lib/agents/config";
import { resolveEffectiveAgentDefinition } from "@/lib/agents/effective";
import { launchAgentRun } from "@/lib/agents/launch";
import { buildOperationalContract } from "@/lib/agents/launch-contract";
import { runs } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { lockDelegationParent } from "@/lib/orchestrator/admission";
import { captureNativeDelegationInput } from "@/lib/orchestrator/native-input";
import { resolveResultContractForDelegation } from "@/lib/run-results/resolve-profile";

type DispatchInput = Readonly<{
  body: DelegateBody;
  projectId: string;
  parentRunId: string;
  tokenId: string;
}>;

/** Existing standalone launch with an authorized native work reservation and a replayable Run identity. */
export async function dispatchProjectAssignmentChild(
  db: Db,
  { body, projectId, parentRunId, tokenId }: DispatchInput,
): Promise<{ childRunId: string; status: string }> {
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
    body.prompt.length > 8000
  )
    throw new MaisterError(
      "CONFIG",
      "Project assignment dispatch requires a bounded workspace-none standalone agent request",
    );

  const { receipt, nativeInput, resultContract, request } =
    await db.transaction(async (tx) => {
      await lockDelegationParent(tx, parentRunId);
      const effective = await resolveEffectiveAgentDefinition(
        { projectId, agentId },
        tx,
      );
      const [link] = (
        await tx.execute(sql`
      SELECT id,config FROM agent_project_links
      WHERE project_id=${projectId} AND agent_id=${agentId} AND enabled FOR SHARE
    `)
      ).rows;

      if (
        effective.parsed.flow ||
        !effective.resolvedRevision ||
        typeof link?.id !== "string"
      )
        throw new MaisterError(
          "PRECONDITION",
          "The current project specialist binding is unavailable for standalone dispatch",
        );
      const operational = effective.parsed.kind === "operational";

      if (operational && body.resultProfile !== undefined)
        throw new MaisterError(
          "CONFIG",
          "Operational delegated work uses its own pinned result contract",
        );
      const resultContract = operational
        ? buildOperationalContract(effective)
        : await resolveResultContractForDelegation(tx, {
            parentRunId,
            name: body.resultProfile,
          });

      if (!resultContract?.required)
        throw new MaisterError(
          "CONFIG",
          "Delegated assignment work requires a pinned required result contract",
        );
      const config = resolveAgentConfig(
        effective.parsed.config,
        link.config as Record<string, unknown> | null,
      );
      const nativeInput = await captureNativeDelegationInput(
        tx,
        { kind: "token", tokenId },
        {
          sourceRunId: parentRunId,
          target: { kind: "agent", id: agentId },
          title: "Delegated assignment work",
          prompt: body.prompt,
        },
      );

      if (!nativeInput)
        throw new MaisterError(
          "PRECONDITION",
          "Delegated assignment work requires an enrolled native source",
        );
      const request: DelegatedWorkRequest = {
        tokenId,
        selector: assignmentWork.selector,
        prepared: {
          bounds: DEFAULT_ASSIGNMENT_WORK_BOUNDS,
          sourceRestrictions: nativeInput.sourceRestrictions,
          target: {
            kind: "project_agent",
            projectId,
            attachmentId: link.id,
            configurationSha256: contentDigest(
              Object.keys(config).length ? config : null,
            ),
            role: {
              agentId,
              packageInstallId: effective.packageInstallId,
              packageRevision: effective.resolvedRevision,
              definitionSha256: agentDefinitionSha256(effective.parsed),
            },
          },
          objectiveInput: {
            objective: body.prompt,
            expectedOutcome: assignmentWork.expectedOutcome,
            input: body.prompt,
            targetIds: [],
            inputRefs: [],
            constraints: [],
            verification: [
              { kind: "result", referenceId: null, required: true },
            ],
            expectedResult: {
              schemaRef: resultContract.schemaRef,
              schemaVersion: resultContract.schemaVersion,
              sha256: resultContract.sha256,
              required: true,
            },
          },
        },
      };
      const receipt = await retainDelegatedWorkInTransaction(tx, request);

      return {
        receipt,
        nativeInput,
        resultContract: operational ? null : resultContract,
        request,
      };
    });
  const { work } = receipt;

  if (work.childRunId === null) {
    const launched = await launchAgentRun({
      db,
      agentId,
      projectId,
      nativeInput,
      delegatedWork: request,
      resultContract,
      taskId: null,
      workspace: "none",
      runId: work.reservedRunId,
      parentRunId,
      rootRunId: work.definition.parent.rootRunId,
      launchMode: "manual",
      trigger: { source: "manual" },
    });

    if (!("deduped" in launched))
      return { childRunId: launched.runId, status: launched.status };
  }
  const replay = await db.transaction(async (tx) => {
    const retained = await retainDelegatedWorkInTransaction(tx, request);
    const childRunId = retained.work.childRunId;

    if (childRunId !== work.reservedRunId)
      throw new MaisterError(
        "CONFLICT",
        "Delegated work is reserved and its Run is not yet bound",
        {
          details: { reason: "delegated_work_binding_changed" },
        },
      );
    const [child] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, childRunId));

    if (!child)
      throw new MaisterError("CRASH", "The bound delegated Run is unavailable");

    return { childRunId, status: child.status };
  });

  return replay;
}
