import "server-only";

import type { SqlDatabase, SqlTransaction } from "@/lib/db/sql-types";
import type { CompanyUserAuthority } from "@/lib/company/authority";
import type {
  CompanyBindingCreate,
  CompanyBindingRevision,
  CompanySpecialist,
  CompanySpecialistBindingSnapshot,
} from "./company-binding-types";

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import pino from "pino";

import { agentDefinitionSha256 } from "./activity-snapshot";
import { assertInstallationAgentDefinition } from "./company-agent-definition";
import {
  decodeCompanyBindingRevision,
  retainCompanyBindingRevision,
} from "./company-binding-snapshot";
import {
  bindingConfigurationSchema,
  companyBindingCreateSchema,
  companySpecialistSchema,
} from "./company-binding-types";
import { resolveAgentConfig, validateInstanceConfig } from "./config";
import {
  resolveInstalledAgentDefinition,
  splitQualifiedAgentId,
} from "./effective";

import { authorizeCompanyUserAction } from "@/lib/company/authority";
import { databaseTimestamp } from "@/lib/db/timestamp";
import { MaisterError } from "@/lib/errors";
import { contentDigest } from "@/lib/evaluations/digest";

const log = pino({
  name: "agents:company-bindings",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function beginCompanyBindingTransaction(
  tx: SqlTransaction,
): Promise<void> {
  await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
  await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
}

export function logCompanyBindingChange(
  actorId: string,
  operation: "created" | "updated",
  result: Readonly<{ specialist: CompanySpecialist; duplicate: boolean }>,
): void {
  const { specialist, duplicate } = result;

  log.info(
    {
      actorId,
      operation,
      bindingId: specialist.bindingId,
      companyId: specialist.owner.companyId,
      agentId: specialist.id,
      revision: specialist.configRevision,
      packageInstallId: specialist.packageInstallId,
      definitionSha256: specialist.definitionSha256,
      policyPreset: specialist.executionPolicy.preset,
      installationScopeCount: specialist.installationGrant?.scopes.length ?? 0,
      enabled: specialist.enabled,
      duplicate,
    },
    "company specialist configuration retained",
  );
}

export type CompanyBindingHead = Readonly<{
  id: string;
  companyId: string;
  agentId: string;
  revision: number;
  createdAt: string;
}>;

export function decodeCompanyBindingHead(
  row: Readonly<Record<string, unknown>> | undefined,
): CompanyBindingHead {
  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The company specialist binding is unavailable",
      { details: { reason: "company_binding_reference_unavailable" } },
    );
  const createdAt = databaseTimestamp(row.created_at);

  if (
    typeof row.id !== "string" ||
    typeof row.company_id !== "string" ||
    typeof row.agent_id !== "string" ||
    typeof row.revision !== "number" ||
    !createdAt
  )
    throw new MaisterError(
      "CONFIG",
      "The company specialist binding head is invalid",
    );

  return {
    id: row.id,
    companyId: row.company_id,
    agentId: row.agent_id,
    revision: row.revision,
    createdAt,
  };
}

export async function loadCompanyBindingHead(
  tx: SqlTransaction,
  agentId: string,
  bindingId: string,
): Promise<CompanyBindingHead> {
  splitQualifiedAgentId(agentId);

  return decodeCompanyBindingHead(
    (
      await tx.execute(
        sql`SELECT * FROM company_specialist_bindings WHERE id=${bindingId} AND agent_id=${agentId}`,
      )
    ).rows[0],
  );
}

export async function loadCompanyBindingRevision(
  tx: SqlTransaction,
  head: CompanyBindingHead,
  revision: number,
): Promise<CompanyBindingRevision> {
  const row = (
    await tx.execute(
      sql`SELECT * FROM company_specialist_binding_revisions WHERE binding_id=${head.id} AND revision=${revision}`,
    )
  ).rows[0];

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The retained company specialist configuration revision is unavailable",
      { details: { reason: "company_binding_reference_unavailable" } },
    );
  const retained = decodeCompanyBindingRevision(row);

  if (
    retained.snapshot.agentId !== head.agentId ||
    retained.authoritySnapshot.witness.owner.companyId !== head.companyId
  )
    throw new MaisterError(
      "CRASH",
      "The retained company specialist configuration has a different owner or role",
    );

  return retained;
}

export function companySpecialistDto(
  head: CompanyBindingHead,
  retained: CompanyBindingRevision,
): CompanySpecialist {
  const snapshot = retained.snapshot;
  const definition = snapshot.definition;

  return companySpecialistSchema.parse({
    id: head.agentId,
    bindingId: head.id,
    owner: { kind: "company", companyId: head.companyId },
    name: definition.name,
    description: definition.description,
    responsibilities: definition.specialist?.responsibilities,
    targetClasses: definition.specialist?.targetClasses,
    kind: definition.kind,
    workspace: definition.workspace,
    capabilityProfile: definition.capabilityProfile,
    platformMcp: definition.platformMcp,
    packageInstallId: snapshot.packageInstallId,
    packageRevision: snapshot.packageRevision,
    definitionSha256: snapshot.definitionSha256,
    enabled: snapshot.enabled,
    detachedAt: snapshot.detachedAt,
    configRevision: retained.revision,
    configuration: snapshot.configuration,
    effectiveConfiguration: snapshot.effectiveConfiguration,
    grantActions: snapshot.grantActions,
    runnerId: snapshot.runnerId,
    executionPolicy: snapshot.executionPolicy,
    coordinatorFlowRevisionId: snapshot.coordinatorFlowRevisionId,
    ...(snapshot.installationGrant && {
      installationGrant: snapshot.installationGrant,
    }),
    createdAt: head.createdAt,
    updatedAt: retained.createdAt,
  });
}

export async function buildCompanyBindingSnapshot(
  tx: SqlTransaction,
  agentId: string,
  input: ReturnType<typeof companyBindingCreateSchema.parse>,
): Promise<CompanySpecialistBindingSnapshot> {
  const effective = await resolveInstalledAgentDefinition(tx, {
    agentId,
    packageInstallId: input.packageInstallId,
  });
  const catalog = (
    await tx.execute(
      sql`SELECT enabled,quarantined_at FROM agents WHERE id=${agentId} FOR SHARE`,
    )
  ).rows[0];

  if (!catalog || catalog.enabled !== true || catalog.quarantined_at !== null)
    throw new MaisterError(
      "PRECONDITION",
      "The specialist catalog role is disabled, quarantined or unavailable",
    );
  if (!effective.parsed.specialist)
    throw new MaisterError(
      "PRECONDITION",
      "The selected pinned agent does not declare a professional specialist role",
    );
  if (
    effective.resolvedRevision !== input.packageRevision ||
    agentDefinitionSha256(effective.parsed) !== input.definitionSha256
  )
    throw new MaisterError(
      "CONFLICT",
      "The selected specialist definition or package revision does not match the reviewed witness",
    );
  const configurationError = validateInstanceConfig(
    effective.parsed.config,
    input.configuration,
  );
  if (input.installationGrant) {
    assertInstallationAgentDefinition(effective.parsed);
    if (input.coordinatorFlowRevisionId !== null)
      throw new MaisterError(
        "CONFIG",
        "An installation agent cannot bind a coordinator Flow",
      );
  }

  if (configurationError) throw new MaisterError("CONFIG", configurationError);
  if (input.runnerId !== null) {
    const runner = (
      await tx.execute(
        sql`SELECT id FROM platform_acp_runners WHERE id=${input.runnerId} AND enabled=true FOR SHARE`,
      )
    ).rows[0];

    if (!runner)
      throw new MaisterError(
        "PRECONDITION",
        "The selected specialist runner is unavailable or disabled",
      );
  }
  if (input.coordinatorFlowRevisionId !== null) {
    const member = effective.manifest?.spec.flows.find(
      (flow) => flow.id === effective.parsed.flow,
    );

    if (!member)
      throw new MaisterError(
        "PRECONDITION",
        "The coordinator Flow is not a member of the selected specialist package",
      );
    const flow = (
      await tx.execute(
        sql`SELECT id FROM flow_revisions WHERE id=${input.coordinatorFlowRevisionId} AND flow_ref_id=${effective.parsed.flow} AND source=${join(effective.installedPath, member.path)} AND resolved_revision=${input.packageRevision} AND package_status='Installed' AND exec_trust='trusted' FOR SHARE`,
      )
    ).rows[0];

    if (!effective.parsed.flow || !flow)
      throw new MaisterError(
        "PRECONDITION",
        "The coordinator Flow must match the declared role and exact trusted package revision",
      );
  }

  return {
    schemaVersion: 1,
    agentId,
    packageInstallId: effective.packageInstallId,
    packageName: effective.packageName,
    packageVersion: effective.versionLabel,
    packageRevision: input.packageRevision,
    definitionSha256: input.definitionSha256,
    definition: effective.parsed,
    enabled: input.enabled,
    detachedAt: null,
    detachmentReason: null,
    configuration: input.configuration,
    effectiveConfiguration: bindingConfigurationSchema.parse(
      resolveAgentConfig(effective.parsed.config, input.configuration),
    ),
    grantActions: input.grantActions,
    runnerId: input.runnerId,
    executionPolicy: input.executionPolicy,
    coordinatorFlowRevisionId: input.coordinatorFlowRevisionId,
    ...(input.installationGrant && {
      installationGrant: input.installationGrant,
    }),
  };
}

export async function assertInstallationGrantAdmin(
  tx: SqlTransaction,
  userId: string,
): Promise<void> {
  const result =
    await tx.execute(sql`SELECT 1 FROM users WHERE id=${userId} AND account_status='active'
    AND role='admin' AND NOT must_change_password FOR SHARE`);
  if (!result.rows.length) {
    log.warn(
      { userId, reason: "installation_grant_admin_required" },
      "installation binding change refused",
    );
    throw new MaisterError(
      "UNAUTHORIZED",
      "Installation reach requires a current global administrator",
    );
  }
}

export async function retainBindingChange(
  tx: SqlTransaction,
  head: CompanyBindingHead,
  authority: CompanyUserAuthority,
  input: Readonly<{
    snapshot: CompanySpecialistBindingSnapshot;
    operation: "created" | "updated" | "detached";
    requestKey: string;
    requestDigest: string;
  }>,
): Promise<CompanyBindingRevision> {
  await retainCompanyBindingRevision(tx, {
    bindingId: head.id,
    revision: head.revision,
    snapshot: input.snapshot,
    authoritySnapshot: {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      actor: authority.actor,
      witness: authority.witness,
    },
    operation: input.operation,
    requestKey: input.requestKey,
    requestDigest: input.requestDigest,
  });

  return loadCompanyBindingRevision(tx, head, head.revision);
}

export async function createCompanySpecialistBinding(
  db: SqlDatabase,
  userId: string,
  agentId: string,
  request: CompanyBindingCreate,
): Promise<{ specialist: CompanySpecialist; duplicate: boolean }> {
  const parsed = companyBindingCreateSchema.safeParse(request);

  if (!parsed.success)
    throw new MaisterError(
      "CONFIG",
      "The company specialist binding request is invalid",
    );
  splitQualifiedAgentId(agentId);
  const input = parsed.data;
  const digest = contentDigest({ agentId, operation: "created", input });

  const result = await db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    if (input.installationGrant) await assertInstallationGrantAdmin(tx, userId);
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
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-binding-create:${input.owner.companyId}:${userId}:${input.idempotencyKey}`},0))`,
    );
    const previous = (
      await tx.execute(
        sql`SELECT * FROM company_specialist_bindings WHERE company_id=${input.owner.companyId} AND created_by=${userId} AND creation_key=${input.idempotencyKey}`,
      )
    ).rows[0];

    if (previous) {
      if (previous.creation_digest !== digest)
        throw new MaisterError(
          "CONFLICT",
          "The company binding delivery key was already used for different content",
        );
      const head = decodeCompanyBindingHead(previous);

      return {
        specialist: companySpecialistDto(
          head,
          await loadCompanyBindingRevision(tx, head, 1),
        ),
        duplicate: true,
      };
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`company-binding-role:${input.owner.companyId}:${agentId}`},0))`,
    );
    const existing = (
      await tx.execute(
        sql`SELECT id FROM company_specialist_bindings WHERE company_id=${input.owner.companyId} AND agent_id=${agentId} AND detached_at IS NULL`,
      )
    ).rows[0];

    if (existing)
      throw new MaisterError(
        "CONFLICT",
        "The company already has a current binding for this specialist; update its exact revision",
      );
    const snapshot = await buildCompanyBindingSnapshot(tx, agentId, input);
    const id = randomUUID();
    const head = decodeCompanyBindingHead(
      (
        await tx.execute(
          sql`INSERT INTO company_specialist_bindings(id,company_id,agent_id,package_install_id,enabled,created_by,creation_key,creation_digest) VALUES(${id},${input.owner.companyId},${agentId},${input.packageInstallId},${input.enabled},${userId},${input.idempotencyKey},${digest}) RETURNING *`,
        )
      ).rows[0],
    );
    const revision = await retainBindingChange(tx, head, authority, {
      snapshot,
      operation: "created",
      requestKey: input.idempotencyKey,
      requestDigest: digest,
    });

    return {
      specialist: companySpecialistDto(head, revision),
      duplicate: false,
    };
  });

  logCompanyBindingChange(userId, "created", result);

  return result;
}

export async function getCompanySpecialistBinding(
  db: SqlDatabase,
  userId: string,
  agentId: string,
  bindingId: string,
): Promise<CompanySpecialist> {
  return db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const head = await loadCompanyBindingHead(tx, agentId, bindingId);

    await authorizeCompanyUserAction(
      tx,
      userId,
      head.companyId,
      "specialists:read",
    );

    return companySpecialistDto(
      head,
      await loadCompanyBindingRevision(tx, head, head.revision),
    );
  });
}

export async function getCompanySpecialistBindingRevision(
  db: SqlDatabase,
  userId: string,
  agentId: string,
  bindingId: string,
  revision: number,
): Promise<CompanyBindingRevision> {
  if (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)
    throw new MaisterError(
      "CONFIG",
      "A positive retained binding revision is required",
    );

  return db.transaction(async (tx) => {
    await beginCompanyBindingTransaction(tx);
    const head = await loadCompanyBindingHead(tx, agentId, bindingId);

    await authorizeCompanyUserAction(
      tx,
      userId,
      head.companyId,
      "specialists:read",
    );

    return loadCompanyBindingRevision(tx, head, revision);
  });
}
