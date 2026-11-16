import "server-only";

import type { KnowledgeAccessWalk } from "@/lib/brain/knowledge-restrictions";
import type { Db } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";
import type { AssignmentInputRevision } from "@/lib/specialist-assignments/types";
import type { EffectiveAgentDefinition } from "./effective";
import type { CompanyRunCredentialOwner } from "./company-run-credential-owner";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import { bindingConfigurationSchema } from "./company-binding-types";
import { assertStandaloneCompanyAgentDefinition } from "./company-agent-definition";
import { requireCompanyKnowledgeRunOwner } from "./company-run-credential-owner";
import { frozenOperationalDefinition } from "./launch-contract";
import { resolveInstalledAgentDefinition } from "./effective";
import { agentDefinitionSha256 } from "./activity-snapshot";
import { resolveAgentConfig } from "./config";
import { scheduledRequestBlock } from "./scheduled-request";
import { companyReplacementTriggerSource } from "./company-trigger-reservation";

import { assertNativeRunKnowledgeInputsInTransaction } from "@/lib/brain/knowledge-execution-access";
import { inspectKnowledgeEvidenceReference } from "@/lib/brain/knowledge-reference";
import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { runs, runSessions, platformAcpRunners } from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";
import { decodeAssignmentInput } from "@/lib/specialist-assignments/input-snapshot";
import {
  expandExecutionPolicy,
  executionPolicySchema,
} from "@/lib/runs/execution-policy";

const log = pino({
  name: "agents:company-session-context",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CompanyAgentSessionContext = Readonly<{
  run: Run;
  owner: CompanyRunCredentialOwner;
  input: AssignmentInputRevision;
  effective: EffectiveAgentDefinition;
  configuration: Readonly<Record<string, string | number | boolean>>;
}>;

/** Read frozen execution input under current authority; call inside the effect admission transaction. */
export async function loadCompanyAgentSessionContext(
  tx: Db,
  runId: string,
): Promise<CompanyAgentSessionContext> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");

  if (
    !run ||
    run.runKind !== "agent" ||
    run.companyId === null ||
    run.projectId !== null
  )
    throw new MaisterError(
      "PRECONDITION",
      "Select an exact company agent execution",
      { details: { reason: "company_agent_runtime_unavailable" } },
    );
  const owner = await requireCompanyKnowledgeRunOwner(tx, runId);

  await authorizeCompanyUserAction(
    tx,
    owner.userId,
    owner.companyId,
    "assignments:update",
  );
  if (run.retryOfRunId)
    await authorizeCompanyUserAction(
      tx,
      owner.userId,
      owner.companyId,
      "assignments:recover",
    );
  if (run.retryOfRunId)
    await companyReplacementTriggerSource(
      tx,
      run.retryOfRunId,
      owner.userId,
      run.triggerSource,
    );
  const row = (
    await tx.execute(
      sql`SELECT * FROM specialist_input_revisions WHERE assignment_id=${owner.snapshot.assignment.id} AND revision=${owner.snapshot.assignment.inputRevision} FOR SHARE`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The exact retained assignment input is unavailable",
      { details: { reason: "company_assignment_input_unavailable" } },
    );
  const input = decodeAssignmentInput(row);
  const effective = frozenOperationalDefinition(run);
  const standing =
    owner.delegated?.binding ?? input.snapshot.standingDefinition;

  if (
    !effective ||
    input.digest !== owner.snapshot.assignment.inputSha256 ||
    standing.definitionSha256 !== agentDefinitionSha256(effective.parsed)
  )
    throw new MaisterError(
      "CONFIG",
      "Company execution and retained assignment definition witnesses differ",
      { details: { reason: "company_agent_pin_changed" } },
    );
  assertStandaloneCompanyAgentDefinition(effective.parsed);
  const installed = await resolveInstalledAgentDefinition(tx, {
    agentId: owner.agentId,
    packageInstallId: standing.packageInstallId,
  });

  if (
    installed.resolvedRevision !== standing.packageRevision ||
    agentDefinitionSha256(installed.parsed) !== standing.definitionSha256
  )
    throw new MaisterError(
      "PRECONDITION",
      "The installed specialist differs from its retained execution witness",
      { details: { reason: "company_agent_pin_changed" } },
    );
  const policy = executionPolicySchema.safeParse(run.executionPolicy);
  const parsedConfiguration = bindingConfigurationSchema.safeParse(
    resolveAgentConfig(effective.parsed.config, standing.configuration),
  );

  if (
    !policy.success ||
    !parsedConfiguration.success ||
    contentDigest(parsedConfiguration.data) !==
      contentDigest(run.agentConfig) ||
    contentDigest(
      expandExecutionPolicy(input.snapshot.authoritySnapshot.executionPolicy),
    ) !== contentDigest(expandExecutionPolicy(policy.data))
  )
    throw new MaisterError(
      "CONFIG",
      "Company execution configuration or policy differs from the exact retained assignment input",
      { details: { reason: "company_agent_input_mismatch" } },
    );
  const configuration = parsedConfiguration.data;
  const [session] = await tx
    .select({
      runnerId: runSessions.runnerId,
      snapshot: runSessions.runnerSnapshot,
    })
    .from(runSessions)
    .where(
      and(eq(runSessions.runId, runId), eq(runSessions.sessionName, "default")),
    )
    .for("share");
  const [runner] = session?.runnerId
    ? await tx
        .select()
        .from(platformAcpRunners)
        .where(eq(platformAcpRunners.id, session.runnerId))
        .for("share")
    : [];

  if (
    !runner ||
    !runner.enabled ||
    runner.readinessStatus !== "Ready" ||
    runner.adapter !== session?.snapshot?.adapter ||
    runner.capabilityAgent !== session.snapshot.capabilityAgent
  )
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The frozen company session runner is disabled, unavailable or incompatible; review its current readiness",
      { details: { reason: "company_agent_runner_unavailable" } },
    );
  await assertNativeRunKnowledgeInputsInTransaction(tx, runId);
  let access: KnowledgeAccessWalk = { visited: [], remaining: 256 };

  for (const reference of (
    owner.delegated?.definition.objectiveInput ?? input.snapshot.objectiveInput
  ).inputRefs)
    access = await inspectKnowledgeEvidenceReference(
      tx,
      { kind: "execution", runId, nodeAttemptId: null },
      reference,
      access,
    );
  log.debug(
    {
      runId,
      assignmentId: input.assignmentId,
      inputRevision: input.revision,
      bindingId: owner.snapshot.specialistBinding.id,
      runnerId: runner.id,
    },
    "current company session input authorized",
  );

  return { run, owner, input, effective, configuration };
}

/** Keep standing role, work, sources, recurring ask and historical execution policy as separate prompt planes. */
export function buildCompanyAgentPrompt(
  context: CompanyAgentSessionContext,
): string {
  const input = context.input.snapshot;
  const objective =
    context.owner.delegated?.definition.objectiveInput ?? input.objectiveInput;
  const sections = [
    context.effective.parsed.prompt.trim(),
    "## Company assignment scope\n" +
      JSON.stringify({
        companyId: context.owner.companyId,
        assignmentId: context.input.assignmentId,
        inputRevision: context.input.revision,
        inputSha256: context.input.digest,
        runId: context.run.id,
      }),
    "## Effective configuration\n" + JSON.stringify(context.configuration),
    "## Assignment objective\n" +
      JSON.stringify({
        objective: objective.objective,
        expectedOutcome: objective.expectedOutcome,
        input: objective.input,
        targetIds: objective.targetIds,
      }),
    "## Knowledge input references\n" + JSON.stringify(objective.inputRefs),
    "## Assignment constraints\n" + JSON.stringify(objective.constraints),
    "## Required result and verification\n" +
      JSON.stringify({
        expectedResult: objective.expectedResult,
        verification: objective.verification,
      }),
    "## Retained execution policy\nThis historical snapshot does not grant current permissions. Platform authorization and human approvals govern every action.\n" +
      JSON.stringify(input.authoritySnapshot.executionPolicy),
  ];
  const recurring = context.owner.delegated
    ? null
    : scheduledRequestBlock(input.scheduledRequest);

  if (recurring) sections.push(recurring);

  return sections.join("\n\n");
}
