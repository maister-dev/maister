import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { EffectiveAgentDefinition } from "./effective";
import type { BindingConfiguration } from "./company-binding-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { loadCompanyFlowSessionContext } from "./company-flow-session-context";
import {
  loadCompanyBindingHead,
  loadCompanyBindingRevision,
} from "./company-bindings";
import { resolveInstalledAgentDefinition } from "./effective";
import {
  agentDefinitionSha256,
  buildAgentActivitySnapshot,
} from "./activity-snapshot";
import { requireCompanyFlowProfessionalRole } from "./company-run-credential-owner";

import { redactQueryError, queryErrorDiagnostics } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "agents:company-flow-persona",
  level: process.env.LOG_LEVEL ?? "info",
});

type CompanyPersonaQuery = Pick<Db, "select" | "execute">;
type CompanyPersonaDatabase = {
  transaction<T>(action: (tx: CompanyPersonaQuery) => Promise<T>): Promise<T>;
};
export type CompanyFlowPersona = Readonly<{
  effective: EffectiveAgentDefinition;
  configuration: BindingConfiguration;
}>;

/** Resolve an explicit company's reviewed professional pin; catalog index rows never choose package bytes. */
export async function resolveCompanyFlowPersona(
  db: CompanyPersonaDatabase,
  runId: string,
  agentId: string,
): Promise<CompanyFlowPersona> {
  try {
    return await db.transaction(async (tx) => {
      const context = await loadCompanyFlowSessionContext(tx, runId);
      const row = (
        await tx.execute(
          sql`SELECT id FROM company_specialist_bindings WHERE company_id=${context.owner.companyId} AND agent_id=${agentId} AND enabled AND detached_at IS NULL FOR SHARE`,
        )
      ).rows[0];

      if (typeof row?.id !== "string")
        throw new MaisterError(
          "UNAUTHORIZED",
          "The company Flow persona has no current reviewed specialist binding",
        );
      const head = await loadCompanyBindingHead(tx, agentId, row.id);
      const binding = await loadCompanyBindingRevision(tx, head, head.revision);
      const effective = await resolveInstalledAgentDefinition(tx, {
        agentId,
        packageInstallId: binding.snapshot.packageInstallId,
      });

      if (
        effective.resolvedRevision !== binding.snapshot.packageRevision ||
        agentDefinitionSha256(effective.parsed) !==
          binding.snapshot.definitionSha256
      )
        throw new MaisterError(
          "CONFIG",
          "The company Flow persona's installed bytes differ from its reviewed definition",
        );
      const activity = buildAgentActivitySnapshot(agentId, effective);

      await requireCompanyFlowProfessionalRole(tx, context.owner, {
        schemaVersion: 1,
        agentId,
        packageInstallId: effective.packageInstallId,
        packageName: effective.packageName,
        definitionSha256: activity.definitionSha256,
      });
      log.debug(
        {
          runId,
          companyId: context.owner.companyId,
          agentId,
          bindingId: head.id,
          bindingRevision: head.revision,
          packageInstallId: effective.packageInstallId,
          definitionSha256: activity.definitionSha256,
        },
        "reviewed company Flow persona resolved",
      );

      return {
        effective,
        configuration: binding.snapshot.effectiveConfiguration,
      };
    });
  } catch (error) {
    log.warn(
      {
        runId,
        agentId,
        code: error instanceof MaisterError ? error.code : undefined,
        ...queryErrorDiagnostics(error),
      },
      "company Flow persona refused",
    );
    throw redactQueryError(error);
  }
}
