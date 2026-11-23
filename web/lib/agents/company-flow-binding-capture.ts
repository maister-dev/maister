import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";
import type {
  CompanyFlowBindingConfiguration,
  CompanyFlowBindingSnapshot,
} from "./company-flow-binding-types";

import { join } from "node:path";

import { sql } from "drizzle-orm";

import { agentDefinitionSha256 } from "./activity-snapshot";
import {
  companyFlowExecutionSchema,
  companyFlowRoleMappingsMatch,
  COMPANY_EXECUTION_ENGINE_MIN,
} from "./company-flow-binding-types";
import {
  decodeCompanyBindingHead,
  loadCompanyBindingRevision,
} from "./company-bindings";
import { resolveInstalledAgentDefinition } from "./effective";

import { MaisterError } from "@/lib/errors";
import { isEngineCompatible } from "@/lib/flows/engine-version";
import {
  parseExecutableStoredFlowManifest,
  parseRetainedGraphShape,
} from "@/lib/flows/manifest-parser";

/** Capture accepted configuration under current provider/role/user authority, without admitting execution. */
export async function captureCompanyFlowBinding(
  tx: SqlTransaction,
  input: CompanyFlowBindingConfiguration,
): Promise<CompanyFlowBindingSnapshot> {
  const roleRow = (
    await tx.execute(
      sql`SELECT b.*,a.enabled AS catalog_enabled,a.quarantined_at FROM company_specialist_bindings b JOIN agents a ON a.id=b.agent_id WHERE b.id=${input.specialistBindingId} FOR SHARE OF b,a`,
    )
  ).rows[0];
  const head = decodeCompanyBindingHead(roleRow);

  if (
    head.companyId !== input.owner.companyId ||
    head.revision !== input.specialistRevision
  )
    throw new MaisterError(
      "CONFLICT",
      "The responsible specialist does not match the reviewed company and configuration revision",
    );
  if (roleRow?.catalog_enabled !== true || roleRow.quarantined_at !== null)
    throw new MaisterError(
      "PRECONDITION",
      "The responsible professional role is disabled or quarantined",
    );
  const role = (await loadCompanyBindingRevision(tx, head, head.revision))
    .snapshot;

  if (
    role.detachedAt !== null ||
    role.coordinatorFlowRevisionId !== input.flowRevisionId
  )
    throw new MaisterError(
      "CONFLICT",
      "The responsible specialist is retired or pins a different coordinator Flow",
    );
  const provider = await resolveInstalledAgentDefinition(tx, {
    agentId: head.agentId,
    packageInstallId: role.packageInstallId,
  });

  if (
    provider.resolvedRevision !== role.packageRevision ||
    agentDefinitionSha256(provider.parsed) !== role.definitionSha256
  )
    throw new MaisterError(
      "CONFLICT",
      "The installed professional role differs from its accepted specialist witness",
    );
  const member = provider.manifest?.spec.flows.find(
    (entry) => entry.id === role.definition.flow,
  );

  if (!member)
    throw new MaisterError(
      "PRECONDITION",
      "The coordinator Flow is not a member of the responsible specialist package",
    );
  const flow = (
    await tx.execute(
      sql`SELECT id,flow_ref_id,resolved_revision,manifest,manifest_digest FROM flow_revisions WHERE id=${input.flowRevisionId} AND source=${join(provider.installedPath, member.path)} AND flow_ref_id=${member.id} AND resolved_revision=${role.packageRevision} AND package_status='Installed' AND exec_trust='trusted' FOR SHARE`,
    )
  ).rows[0];

  if (!flow || typeof flow.flow_ref_id !== "string")
    throw new MaisterError(
      "PRECONDITION",
      "The exact trusted installed coordinator Flow is unavailable",
    );
  if (flow.manifest_digest !== input.manifestSha256)
    throw new MaisterError(
      "CONFLICT",
      "The coordinator Flow manifest differs from the reviewed content witness",
    );
  const manifestContext = {
    surface: "company-flow-binding-capture",
    flowRefId: flow.flow_ref_id,
    revision: role.packageRevision,
    manifestLabel: "company coordinator Flow",
    code: "CONFIG" as const,
  };
  const manifest = parseRetainedGraphShape(flow.manifest, manifestContext);

  if (!companyFlowRoleMappingsMatch(manifest, input.roleMappings))
    throw new MaisterError(
      "CONFIG",
      "Every coordinator human role must have an explicit reviewed mapping; undeclared mappings are refused",
    );
  const recipients = [
    ...new Set(Object.values(input.roleMappings).flat()),
  ].sort();
  const authorities =
    recipients.length === 0
      ? []
      : (
          await tx.execute(
            sql`SELECT u.id AS user_id,g.id AS grant_id,g.revision FROM users u JOIN company_grants g ON g.principal_type='user' AND g.principal_id=u.id AND g.company_id=${head.companyId} AND g.action='assignments:answer' AND g.revoked_at IS NULL WHERE u.id IN (${sql.join(
              recipients.map((recipient) => sql`${recipient}`),
              sql`,`,
            )}) AND u.account_status='active' AND u.must_change_password=false ORDER BY u.id FOR SHARE OF u,g`,
          )
        ).rows;

  if (authorities.length !== recipients.length)
    throw new MaisterError(
      "UNAUTHORIZED",
      "Every mapped company coordinator recipient must have current active account and assignment-answer authority",
    );
  const routingAuthority = authorities.map((authority) => {
    if (
      typeof authority.user_id !== "string" ||
      typeof authority.grant_id !== "string" ||
      typeof authority.revision !== "number"
    )
      throw new MaisterError(
        "CONFIG",
        "The company coordinator routing authority witness is invalid",
      );

    return {
      userId: authority.user_id,
      witness: {
        kind: "company_grant" as const,
        owner: input.owner,
        authorityId: authority.grant_id,
        revision: authority.revision,
        action: "assignments:answer" as const,
      },
    };
  });

  if (input.enabled) {
    parseExecutableStoredFlowManifest(flow.manifest, manifestContext);
    const compatible = isEngineCompatible(COMPANY_EXECUTION_ENGINE_MIN);
    const declaration = companyFlowExecutionSchema.safeParse(
      manifest.execution,
    );

    if (
      !compatible.compatible ||
      !declaration.success ||
      !role.enabled ||
      manifest.result?.export.required !== true
    )
      throw new MaisterError(
        "PRECONDITION",
        "Company coordinator enablement requires the supported result-only execution declaration, an enabled specialist and a required result contract",
        {
          details: {
            reason: "company_execution_contract_unavailable",
            engineMin: COMPANY_EXECUTION_ENGINE_MIN,
          },
        },
      );
  }

  return {
    schemaVersion: 1,
    companyId: head.companyId,
    flowRefId: flow.flow_ref_id,
    flowRevisionId: input.flowRevisionId,
    packageInstallId: role.packageInstallId,
    packageRevision: role.packageRevision,
    manifestSha256: input.manifestSha256,
    manifest,
    specialistBindingId: head.id,
    specialistRevision: head.revision,
    specialist: role,
    execution: input.execution,
    roleMappings: input.roleMappings,
    routingAuthority,
    enabled: input.enabled,
    detachedAt: null,
    detachmentReason: null,
  };
}
