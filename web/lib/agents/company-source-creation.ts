import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { CompanySpecialistBindingSnapshot } from "./company-binding-types";
import type { CompanyScheduleReceipt } from "./company-schedule-types";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pino from "pino";

import {
  beginCompanyBindingTransaction,
  buildCompanyBindingSnapshot,
  decodeCompanyBindingHead,
  loadCompanyBindingRevision,
} from "./company-bindings";
import {
  lockCompanyFlowBindingConfiguration,
  loadCompanyFlowBindingRevision,
} from "./company-flow-bindings";
import { installationScheduleReviewSchema } from "./installation-appointment";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";

export type CompanySourceConfigurationInput = Readonly<{
  owner: Readonly<{ kind: "company"; companyId: string }>;
  specialistBindingId: string;
  coordinatorFlowBindingId: string | null;
  enabled: boolean;
  idempotencyKey: string;
}>;
export type CompanySourceWriteContext = Readonly<{
  sourceId: string;
  actorId: string;
  role: CompanySpecialistBindingSnapshot;
  installationReview: string | null;
}>;
type WriteCompanySource = (
  tx: SqlTransaction,
  context: CompanySourceWriteContext,
) => Promise<void>;
const log = pino({
  name: "agents:company-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Preserve the existing source-key receipt/lock and reviewed configuration policy for both native source adapters. */
export async function createCompanyScheduleSource(
  db: SqlDatabase,
  userId: string,
  input: CompanySourceConfigurationInput,
  digest: string,
  declaredTrigger: "cron" | "domain_event",
  writeSource: WriteCompanySource,
): Promise<CompanyScheduleReceipt> {
  const result = await db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const authority = await authorizeCompanyUserAction(
      tx,
      userId,
      input.owner.companyId,
      "specialists:manage",
    );

    await authorizeCompanyUserAction(
      tx,
      userId,
      input.owner.companyId,
      "specialists:read",
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-cron-source:${input.owner.companyId}:${authority.actor.id}:${input.idempotencyKey}`},0))`,
    );
    const previous = (
      await tx.execute(
        sql`SELECT id,company_config_revision,creation_digest FROM agent_schedules WHERE company_id=${input.owner.companyId} AND created_by=${authority.actor.id} AND creation_key=${input.idempotencyKey}`,
      )
    ).rows[0];

    if (previous) {
      if (previous.creation_digest !== digest)
        throw new MaisterError(
          "CONFLICT",
          "The company source delivery key was already used for different configuration",
        );
      if (
        typeof previous.id !== "string" ||
        typeof previous.company_config_revision !== "number"
      )
        throw new MaisterError(
          "CONFIG",
          "The retained company source receipt is invalid",
        );

      return {
        scheduleId: previous.id,
        owner: input.owner,
        configRevision: 1,
        duplicate: true,
      };
    }
    const coordinatorHead =
      input.coordinatorFlowBindingId === null
        ? null
        : await lockCompanyFlowBindingConfiguration(
            tx,
            input.coordinatorFlowBindingId,
          );

    const roleHead = decodeCompanyBindingHead(
      (
        await tx.execute(
          sql`SELECT * FROM company_specialist_bindings WHERE id=${input.specialistBindingId} FOR SHARE`,
        )
      ).rows[0],
    );

    if (roleHead.companyId !== input.owner.companyId)
      throw new MaisterError(
        "CONFLICT",
        "The selected professional role is owned by another company",
      );
    const reviewed = await loadCompanyBindingRevision(
      tx,
      roleHead,
      roleHead.revision,
    );
    const role = reviewed.snapshot;

    if (role.detachedAt !== null)
      throw new MaisterError(
        "PRECONDITION",
        "The selected professional role has been retired",
      );
    await buildCompanyBindingSnapshot(tx, roleHead.agentId, {
      owner: input.owner,
      packageInstallId: role.packageInstallId,
      packageRevision: role.packageRevision,
      definitionSha256: role.definitionSha256,
      enabled: role.enabled,
      configuration: role.configuration,
      grantActions: [...role.grantActions],
      runnerId: role.runnerId,
      executionPolicy: role.executionPolicy,
      coordinatorFlowRevisionId: role.coordinatorFlowRevisionId,
      ...(role.installationGrant && {
        installationGrant: {
          ...role.installationGrant,
          scopes: [...role.installationGrant.scopes],
        },
      }),
      idempotencyKey: input.idempotencyKey,
    });
    if (
      (role.definition.flow !== null) !==
      (input.coordinatorFlowBindingId !== null)
    )
      throw new MaisterError(
        "PRECONDITION",
        "The source must select the responsible specialist's reviewed coordinator Flow binding",
      );
    if (coordinatorHead !== null) {
      const head = coordinatorHead;

      if (head.companyId !== input.owner.companyId)
        throw new MaisterError(
          "CONFLICT",
          "The selected coordinator Flow is owned by another company",
        );
      const flow = (
        await loadCompanyFlowBindingRevision(tx, head, head.revision)
      ).snapshot;

      if (
        flow.detachedAt !== null ||
        flow.specialistBindingId !== roleHead.id ||
        flow.specialistRevision !== roleHead.revision
      )
        throw new MaisterError(
          "CONFLICT",
          "The selected coordinator Flow no longer matches the current professional role revision",
        );
      if (input.enabled && !flow.enabled)
        throw new MaisterError(
          "PRECONDITION",
          "Enable the reviewed coordinator Flow before enabling its source",
          { details: { reason: "company_flow_binding_disabled" } },
        );
    }
    let installationReview: string | null = null;

    if (input.enabled) {
      if (!role.definition.triggers.includes(declaredTrigger))
        throw new MaisterError(
          "CONFIG",
          "The pinned specialist does not declare this invocation trigger",
          { details: { reason: "company_agent_trigger_unsupported" } },
        );
      if (!role.enabled)
        throw new MaisterError(
          "PRECONDITION",
          "Enable the reviewed specialist before enabling its source",
          { details: { reason: "company_binding_disabled" } },
        );
      for (const action of ["assignments:read", "assignments:submit"] as const)
        await authorizeCompanyUserAction(
          tx,
          userId,
          input.owner.companyId,
          action,
        );
      const admission = await authorizeCompanyUserAction(
        tx,
        userId,
        input.owner.companyId,
        "assignments:update",
      );

      if (role.installationGrant) {
        installationReview = JSON.stringify(
          installationScheduleReviewSchema.parse({
            schemaVersion: 1,
            binding: {
              id: reviewed.bindingId,
              revision: reviewed.revision,
              snapshotSha256: reviewed.snapshotDigest,
            },
            reviewer: admission,
          }),
        );
      }
    }
    const id = randomUUID();

    await writeSource(tx, {
      sourceId: id,
      actorId: authority.actor.id,
      role,
      installationReview,
    });

    return {
      scheduleId: id,
      owner: input.owner,
      configRevision: 1,
      duplicate: false,
    };
  });

  log.info(
    {
      companyId: result.owner.companyId,
      sourceId: result.scheduleId,
      revision: result.configRevision,
      actorId: userId,
      triggerSource: declaredTrigger,
      duplicate: result.duplicate,
    },
    "company source configuration retained",
  );

  return result;
}
