import "server-only";

import type { AgentRetryRecipe } from "./retry-types";

import { z } from "zod";
import pino from "pino";

import { projectAgentProfileSnapshotSchema } from "./project-instance-profile";
import { frozenAgentDefinitionSchema } from "./frozen-definition";
import { scheduledRequestSnapshotSchema } from "./scheduled-request";
import { companyConfigurationReferenceSchema } from "./trigger-attempt-types";

import { maisterPackageManifestSchema } from "@/lib/config.schema";
import { ownerSchema } from "@/lib/company/types";
import { MaisterError } from "@/lib/errors";
import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { postgresTextSchema } from "@/lib/text-schema";
import {
  projectCommentAppointmentSchema,
  projectCronAppointmentSchema,
  projectEventAppointmentSchema,
} from "@/lib/specialist-assignments/project-source-types";

const log = pino({
  name: "retry-snapshot",
  level: process.env.LOG_LEVEL ?? "info",
});

const identity = postgresTextSchema.min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2147483647);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const replacementWitness = z.object({
  sourceRunId: identity,
  assignmentRevision: revision,
  contextRevision: z.number().int().nonnegative().max(2147483647),
  ownerEpoch: revision,
  resultSha256: digest,
  sourceSha256: digest,
});

export const projectSpecialistReplacementSchema = replacementWitness
  .extend({
    assignmentId: identity,
    inputRevision: revision,
    inputSha256: digest,
    cron: projectCronAppointmentSchema.optional(),
    event: projectEventAppointmentSchema.optional(),
    comment: projectCommentAppointmentSchema.optional(),
    webhook: identity.optional(),
    worktree: z
      .object({
        workspaceId: identity,
        baseCommit: commit,
        baseBranch: postgresTextSchema.min(1).max(1024),
        repositorySha256: digest,
      })
      .strict()
      .optional(),
    readOnly: z
      .object({ commit, repositorySha256: digest })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    ({ cron, event, comment, webhook, worktree, readOnly }) =>
      [cron, event, comment, webhook].filter(Boolean).length <= 1 &&
      !(worktree && readOnly),
  );
const common = z.object({
  scheduledRequestSnapshot: scheduledRequestSnapshotSchema.optional(),
  agentId: postgresTextSchema.min(1),
  definition: z
    .object({
      parsed: frozenAgentDefinitionSchema,
      sourcePath: z.string().min(1),
      packageName: z.string().min(1),
      packageInstallId: z.string().min(1),
      installedPath: z.string().min(1),
      manifest: z.record(z.string(), z.unknown()).nullable(),
      versionLabel: z.string().min(1),
      resolvedRevision: z.string().optional(),
      execTrust: z.enum(["untrusted", "trusted"]),
    })
    .passthrough(),
  configuration: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean()]),
  ),
  trigger: z
    .object({
      source: z.enum(["manual", "cron", "domain_event", "webhook", "flow"]),
      eventId: z.number().int().nullable(),
      payload: z.record(z.string(), z.unknown()).nullable(),
    })
    .strict(),
  runner: z
    .object({
      id: z.string().min(1),
      adapter: z.string().min(1),
      capabilityAgent: z.string().min(1),
      model: z.string().min(1),
      env: z.record(z.string(), z.string()).optional(),
      provider: z.record(z.string(), z.unknown()).optional(),
      providerKind: z.string().min(1),
      permissionPolicy: z.string().min(1),
      readOnlyCapable: z.boolean().optional(),
    })
    .strict(),
  policy: executionPolicySchema,
  contextDigest: digest,
});
const projectFields = {
  projectId: z.string().min(1),
  taskId: z.string().nullable(),
  taskRevision: z.number().int().nullable(),
  project: z
    .object({
      mainBranch: z.string(),
      branchPrefix: z.string().nullable(),
      branchBase: z.string().nullable(),
    })
    .strict(),
};
const recipeSchema = z.union([
  common.extend({ ...projectFields, version: z.literal(1) }).strict(),
  common
    .extend({
      ...projectFields,
      version: z.literal(2),
      projectAgentProfile: projectAgentProfileSnapshotSchema.optional(),
      strategy: z.enum(["pre_work_retry", "fresh_qualification"]),
      qualificationSha: z.string().nullable(),
      replacement: projectSpecialistReplacementSchema.optional(),
    })
    .strict(),
  common
    .extend({
      definition: common.shape.definition.extend({
        manifest: z
          .object({
            spec: maisterPackageManifestSchema,
            inventory: z
              .object({
                skills: z.array(z.string()),
                agents: z.array(z.string()),
                platformAgents: z.array(z.string()).optional(),
              })
              .passthrough(),
            sourceSubpath: z.string().optional(),
          })
          .passthrough()
          .nullable(),
      }),
      version: z.literal(3),
      strategy: z.literal("pre_work_retry"),
      owner: ownerSchema.options[0],
      projectId: z.null(),
      taskId: z.null(),
      taskRevision: z.null(),
      project: z.null(),
      specialistBinding: companyConfigurationReferenceSchema,
      coordinatorFlowBinding: companyConfigurationReferenceSchema.nullable(),
      assignment: z
        .object({ id: identity, inputRevision: revision, inputSha256: digest })
        .strict(),
      replacement: replacementWitness
        .extend({ sessionsSha256: digest.optional() })
        .strict()
        .optional(),
    })
    .strict(),
]);

/** Validate retained structure without injecting today's defaults or resolving mutable provider files. */
export function parseAgentRetryRecipe(value: unknown): AgentRetryRecipe {
  const parsed = recipeSchema.safeParse(value);

  if (
    !parsed.success ||
    parsed.data.agentId !== parsed.data.definition.parsed.id ||
    (parsed.data.version === 2 &&
      parsed.data.projectAgentProfile !== undefined &&
      (parsed.data.projectAgentProfile.projectId !== parsed.data.projectId ||
        parsed.data.projectAgentProfile.agentId !== parsed.data.agentId ||
        parsed.data.projectAgentProfile.packageInstallId !==
          parsed.data.definition.packageInstallId))
  ) {
    log.debug(
      {
        issues: parsed.success
          ? ["definition_identity"]
          : parsed.error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
            })),
      },
      "retained retry recipe validation failed",
    );
    throw new MaisterError(
      "CONFIG",
      "Retained retry recipe has an invalid or unsupported version",
      {
        details: { reason: "retry_recipe_invalid" },
      },
    );
  }

  return value as AgentRetryRecipe;
}
