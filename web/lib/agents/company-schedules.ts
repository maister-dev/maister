import "server-only";

import type { SqlDatabase } from "@/lib/db/sql-types";
import type {
  CompanyCronScheduleInput,
  CompanyCronScheduleReceipt,
} from "./company-schedule-types";

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
import { companyCronScheduleInputSchema } from "./company-schedule-types";
import { normalizeScheduledRequest } from "./scheduled-request";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";
import { nextFireAt } from "@/lib/run-schedules/cron";

const log = pino({
  name: "agents:company-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Retain a reviewed source; enabled work requires the creator's current execution authority. */
export async function createCompanyCronSchedule(
  db: SqlDatabase,
  userId: string,
  request: CompanyCronScheduleInput,
): Promise<CompanyCronScheduleReceipt> {
  const parsed = companyCronScheduleInputSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company cron source request is invalid",
    );
  const input = {
    ...parsed.data,
    requestAtLaunch: normalizeScheduledRequest(parsed.data.requestAtLaunch),
  };
  const digest = contentDigest(input);
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
          "The company cron delivery key was already used for different configuration",
        );
      if (
        typeof previous.id !== "string" ||
        typeof previous.company_config_revision !== "number"
      )
        throw new MaisterError(
          "CONFIG",
          "The retained company cron source receipt is invalid",
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
    const role = (
      await loadCompanyBindingRevision(tx, roleHead, roleHead.revision)
    ).snapshot;

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
      idempotencyKey: input.idempotencyKey,
    });
    if (
      (role.definition.flow !== null) !==
      (input.coordinatorFlowBindingId !== null)
    )
      throw new MaisterError(
        "PRECONDITION",
        "The cron source must select the responsible specialist's reviewed coordinator Flow binding",
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
          "Enable the reviewed coordinator Flow before enabling its cron source",
          { details: { reason: "company_flow_binding_disabled" } },
        );
    }
    if (input.enabled) {
      if (!role.definition.triggers.includes("cron"))
        throw new MaisterError(
          "CONFIG",
          "The pinned specialist does not declare cron invocation",
          { details: { reason: "company_agent_trigger_unsupported" } },
        );
      if (!role.enabled)
        throw new MaisterError(
          "PRECONDITION",
          "Enable the reviewed specialist before enabling its cron source",
          { details: { reason: "company_binding_disabled" } },
        );
      if (input.requestAtLaunch === null)
        throw new MaisterError(
          "NEEDS_INPUT",
          "Company scheduled work requires an explicit retained recurring request",
          { details: { reason: "company_scheduled_request_missing" } },
        );
      for (const action of [
        "assignments:read",
        "assignments:submit",
        "assignments:update",
      ] as const)
        await authorizeCompanyUserAction(
          tx,
          userId,
          input.owner.companyId,
          action,
        );
    }
    const next = nextFireAt(input.cronExpr, input.timezone, new Date());
    const id = randomUUID();

    await tx.execute(
      sql`INSERT INTO agent_schedules(id,agent_id,project_id,company_id,company_specialist_binding_id,company_flow_binding_id,company_config_revision,created_by,creation_key,creation_digest,trigger_type,request_at_launch,cron_expr,timezone,next_fire_at,enabled) VALUES(${id},${roleHead.agentId},NULL,${input.owner.companyId},${roleHead.id},${input.coordinatorFlowBindingId},1,${authority.actor.id},${input.idempotencyKey},${digest},'cron',${input.requestAtLaunch},${input.cronExpr},${input.timezone},${next},${input.enabled})`,
    );

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
      duplicate: result.duplicate,
    },
    "company cron source configuration retained",
  );

  return result;
}
