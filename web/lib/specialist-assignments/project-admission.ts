import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { KnowledgeAccessCapture } from "@/lib/company/types";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { RunResultContract } from "@/lib/run-results/types";
import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { AssignmentInputRevision } from "./types";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  getSpecialistAssignmentInTransaction,
  getSpecialistAssignmentInputInTransaction,
  lockSpecialistAssignment,
} from "./store";
import { authorizeAssignment } from "./access";

import { resolveAgentConfig } from "@/lib/agents/config";
import { recommendedExecutionPolicySchema } from "@/lib/agents/definition";
import { resolveAgentLaunchExecutionPolicy } from "@/lib/agents/execution-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { expandExecutionPolicy } from "@/lib/runs/execution-policy";
import { postgresTextSchema } from "@/lib/text-schema";

const identity = postgresTextSchema.min(1).max(128);

/** Internal appointment reference; public callers cannot supply launch authority or snapshots. */
export const projectAssignmentAdmissionSchema = z
  .object({
    assignmentId: identity,
    inputRevision: knowledgeRevisionSchema,
    expectedRevision: knowledgeRevisionSchema,
    userId: identity,
  })
  .strict();
export type ProjectAssignmentAdmission = z.infer<
  typeof projectAssignmentAdmissionSchema
>;
export type ProjectAssignmentLaunchContext = Readonly<{
  projectId: string;
  bindingId: string;
  effective: EffectiveAgentDefinition;
  configuration: Readonly<Record<string, unknown>> | null;
  executionPolicy: ExecutionPolicy;
  resultContract: RunResultContract | null;
}>;

/** Hold responsibility and compare the exact frozen input before the existing Run insert. */
export async function prepareProjectAssignmentAdmission(
  tx: SqlTransaction,
  value: ProjectAssignmentAdmission,
  context: ProjectAssignmentLaunchContext,
): Promise<KnowledgeAccessCapture> {
  const parsed = projectAssignmentAdmissionSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "Project assignment launch requires an exact server appointment",
    );
  const reference = parsed.data;

  await lockSpecialistAssignment(
    tx,
    reference.assignmentId,
    reference.expectedRevision,
  );
  const assignment = await getSpecialistAssignmentInTransaction(
    tx,
    reference.userId,
    reference.assignmentId,
  );
  const input = await getSpecialistAssignmentInputInTransaction(
    tx,
    reference.userId,
    assignment.id,
    reference.inputRevision,
  );
  const snapshot = input.snapshot;
  const standing = snapshot.standingDefinition;
  const result = context.resultContract;
  const current = (
    await tx.execute(sql`
    SELECT binding.config,binding.execution_policy_override,project.execution_policy_default
    FROM agent_project_links binding
    JOIN agents role ON role.id=binding.agent_id
    JOIN projects project ON project.id=binding.project_id
    JOIN project_package_attachments attachment ON attachment.project_id=project.id AND attachment.package_name=role.package_name
    JOIN package_installs pin ON pin.id=attachment.package_install_id
    WHERE binding.id=${context.bindingId} AND binding.project_id=${context.projectId}
      AND binding.agent_id=${context.effective.parsed.id} AND binding.enabled AND role.enabled AND role.quarantined_at IS NULL
      AND project.archived_at IS NULL AND pin.id=${context.effective.packageInstallId}
      AND pin.package_status='Installed' AND pin.trust_status IN ('trusted','trusted_by_policy')
    FOR SHARE OF binding,role,project,attachment,pin
  `)
  ).rows[0];
  const currentSettings = z
    .object({
      config: z.record(z.string(), z.json()).nullable(),
      execution_policy_override: recommendedExecutionPolicySchema.nullable(),
      execution_policy_default: executionPolicySchema.nullable(),
    })
    .safeParse(current);

  if (!currentSettings.success)
    throw new MaisterError(
      "PRECONDITION",
      "The current project specialist attachment, configuration or package is unavailable",
    );
  const currentConfiguration = resolveAgentConfig(
    context.effective.parsed.config,
    currentSettings.data.config,
  );
  const currentPolicy = resolveAgentLaunchExecutionPolicy({
    instanceOverride: currentSettings.data.execution_policy_override,
    recommended: context.effective.parsed.recommended?.executionPolicy,
    projectDefault: currentSettings.data.execution_policy_default,
  });

  if (
    contentDigest(
      Object.keys(currentConfiguration).length === 0
        ? null
        : currentConfiguration,
    ) !== contentDigest(context.configuration) ||
    contentDigest(expandExecutionPolicy(currentPolicy)) !==
      contentDigest(expandExecutionPolicy(context.executionPolicy))
  )
    throw new MaisterError(
      "CONFLICT",
      "Project specialist configuration or policy changed during admission",
      { details: { reason: "project_assignment_launch_mismatch" } },
    );

  await authorizeAssignment(
    tx,
    reference.userId,
    assignment.owner,
    "assignments:update",
    context.executionPolicy,
  );
  if (
    assignment.owner.kind !== "project" ||
    assignment.owner.projectId !== context.projectId ||
    assignment.status !== "queued" ||
    assignment.inputRevision !== reference.inputRevision ||
    assignment.specialistBindingId !== context.bindingId ||
    assignment.requester.kind !== "user" ||
    assignment.requester.id !== reference.userId ||
    standing.agentId !== context.effective.parsed.id ||
    standing.packageInstallId !== context.effective.packageInstallId ||
    standing.packageRevision !== context.effective.resolvedRevision ||
    standing.definitionSha256 !==
      agentDefinitionSha256(context.effective.parsed) ||
    contentDigest(standing.configuration) !==
      contentDigest(context.configuration) ||
    contentDigest(
      expandExecutionPolicy(snapshot.authoritySnapshot.executionPolicy),
    ) !== contentDigest(expandExecutionPolicy(context.executionPolicy)) ||
    result === null ||
    result.required !== true ||
    contentDigest(snapshot.objectiveInput.expectedResult) !==
      contentDigest({
        schemaRef: result.schemaRef,
        schemaVersion: result.schemaVersion,
        sha256: result.sha256,
        required: true,
      })
  )
    throw new MaisterError(
      "CONFLICT",
      "Project admission must match the queued assignment's exact input, professional role, configuration, policy and result contract",
      { details: { reason: "project_assignment_launch_mismatch" } },
    );

  return {
    schemaVersion: 1,
    state: "complete",
    generation: 1,
    restrictions: [
      ...snapshot.sourceRestrictions,
      { kind: "project_context", projectId: context.projectId },
      {
        kind: "assignment_input",
        assignmentId: assignment.id,
        inputRevision: input.revision,
        inputSha256: input.digest,
      },
    ],
  };
}

/** Read the Run's retained appointment; later input heads cannot rewrite its prompt. */
export async function loadProjectAssignmentExecutionInput(
  db: SqlDatabase,
  run: Readonly<{
    id?: string;
    projectId?: string | null;
    knowledgeAccess?: KnowledgeAccessCapture | null;
  }>,
): Promise<AssignmentInputRevision | null> {
  const references =
    run.knowledgeAccess?.restrictions.filter(
      (item) => item.kind === "assignment_input",
    ) ?? [];

  if (references.length === 0) return null;
  if (
    references.length !== 1 ||
    typeof run.id !== "string" ||
    typeof run.projectId !== "string"
  )
    throw new MaisterError(
      "CONFIG",
      "Project execution must have one exact original assignment input",
    );
  const reference = references[0]!;

  return db.transaction(async (tx) => {
    const link = (
      await tx.execute(sql`
      SELECT input.actor->>'id' AS user_id
      FROM specialist_run_links link
      JOIN specialist_assignments assignment ON assignment.id=link.assignment_id
      JOIN specialist_input_revisions input ON input.assignment_id=link.assignment_id AND input.revision=link.input_revision
      WHERE link.run_id=${run.id} AND assignment.project_id=${run.projectId}
        AND link.assignment_id=${reference.assignmentId} AND link.input_revision=${reference.inputRevision}
        AND input.digest=${reference.inputSha256} AND input.actor->>'kind'='user'
      FOR SHARE OF link,assignment,input
    `)
    ).rows[0];

    if (typeof link?.user_id !== "string")
      throw new MaisterError(
        "UNAUTHORIZED",
        "The execution's exact assignment appointment is unavailable",
      );

    return getSpecialistAssignmentInputInTransaction(
      tx,
      link.user_id,
      reference.assignmentId,
      reference.inputRevision,
    );
  });
}

export function projectAssignmentInputPrompt(
  input: AssignmentInputRevision,
): string {
  return (
    "## Original project assignment input\n" +
    JSON.stringify({
      schemaVersion: 1,
      assignmentId: input.assignmentId,
      inputRevision: input.revision,
      inputSha256: input.digest,
      objectiveInput: input.snapshot.objectiveInput,
    })
  );
}
