import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { maisterPackageManifestSchema } from "@/lib/config.schema";
import {
  assertAgentId,
  parseAgentDefinition,
  type ParsedAgentDefinition,
} from "@/lib/agents/definition";
import { getDb } from "@/lib/db/client";
import { assertOperationalAgentCompatibility } from "@/lib/agents/package-contract";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { type PackageInstallManifest } from "@/lib/packages/attach";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

type Db = any;

export function splitQualifiedAgentId(agentId: string): {
  packageName: string;
  stem: string;
} {
  assertAgentId(agentId);

  const idx = agentId.indexOf(":");

  if (idx <= 0 || idx === agentId.length - 1) {
    throw new MaisterError(
      "CONFIG",
      `agent id "${agentId}" is not package-qualified (<packageName>:<stem>)`,
    );
  }

  return { packageName: agentId.slice(0, idx), stem: agentId.slice(idx + 1) };
}

export type EffectiveAgentDefinition = {
  parsed: ParsedAgentDefinition;
  sourcePath: string;
  packageName: string;
  packageInstallId: string;
  installedPath: string;
  manifest: PackageInstallManifest | null;
  versionLabel: string;
  resolvedRevision?: string;
  // T-B3 exec-trust axis — gates stdio MCP spawn for the agent's
  // capability_profile (RD7). A resolved definition always comes from a
  // trusted / trusted_by_policy install (untrusted is refused below), and
  // trustPackageRevision flips package_installs.trust_status together with the
  // member flow_revisions.exec_trust — so the package's trust IS the agent's
  // exec trust.
  execTrust: "untrusted" | "trusted";
};

// (ADR-106) The platform `agents` row is only the catalog projection — the
// definition a launch in project P actually runs is the
// `maister-agents/<stem>.md` inside P's ATTACHED package install (the
// per-project version pin), behind the package gate (attached + trusted +
// Installed). The per-agent enabled/quarantine gate is the CALLER's
// (launch.ts / flow-binding.ts): a flow-bound agent has no agent_project_links
// row, so the resolver must not require one. Resolved at launch (guards) AND
// again at spawn (prompt body) — the attached install is the source of truth,
// never the catalog index row.
export async function resolveEffectiveAgentDefinition(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<EffectiveAgentDefinition> {
  const _db = db ?? getDb();
  const { packageName } = splitQualifiedAgentId(input.agentId);

  const rows = await _db
    .select({
      packageInstallId: packageInstalls.id,
      installedPath: packageInstalls.installedPath,
      manifest: packageInstalls.manifest,
      packageStatus: packageInstalls.packageStatus,
      trustStatus: packageInstalls.trustStatus,
      versionLabel: packageInstalls.versionLabel,
      resolvedRevision: packageInstalls.resolvedRevision,
    })
    .from(projectPackageAttachments)
    .innerJoin(
      packageInstalls,
      eq(projectPackageAttachments.packageInstallId, packageInstalls.id),
    )
    .where(
      and(
        eq(projectPackageAttachments.projectId, input.projectId),
        eq(projectPackageAttachments.packageName, packageName),
      ),
    );
  const install = rows[0];

  if (!install) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" is not attached to this project`,
    );
  }

  return readInstalledAgentDefinition(input.agentId, install);
}

type AgentInstallPin = Readonly<{
  packageInstallId: string;
  installedPath: string;
  manifest: unknown;
  packageStatus: string;
  trustStatus: string;
  versionLabel: string;
  resolvedRevision: string;
}>;

/** The same file, trust and compatibility gates apply to project and company pins. */
async function readInstalledAgentDefinition(
  agentId: string,
  install: AgentInstallPin,
): Promise<EffectiveAgentDefinition> {
  const { packageName, stem } = splitQualifiedAgentId(agentId);

  if (install.packageStatus !== "Installed") {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${agentId}": package "${packageName}" install is ${install.packageStatus}, not Installed`,
    );
  }

  // Allow-list (skill-context): only the two trusted states resolve; untrusted
  // and any future trust state are refused by default.
  if (
    install.trustStatus !== "trusted" &&
    install.trustStatus !== "trusted_by_policy"
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${agentId}": package "${packageName}" is not trusted — confirm trust before launch`,
    );
  }

  const sourcePath = join(
    install.installedPath,
    "maister-agents",
    `${stem}.md`,
  );

  let content: string;

  try {
    content = await readFile(sourcePath, "utf8");
  } catch {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${agentId}": version ${install.versionLabel} of package "${packageName}" does not ship maister-agents/${stem}.md`,
    );
  }

  const parsed = parseAgentDefinition(agentId, content);

  assertOperationalAgentCompatibility(
    parsed,
    (install.manifest as PackageInstallManifest | null)?.spec?.compat,
  );

  return {
    parsed,
    sourcePath,
    packageName,
    packageInstallId: install.packageInstallId,
    installedPath: install.installedPath,
    manifest: install.manifest as PackageInstallManifest | null,
    versionLabel: install.versionLabel,
    resolvedRevision: install.resolvedRevision,
    execTrust: "trusted",
  };
}

/** Resolve an explicit installed pin without synthesizing a project attachment. */
export async function resolveInstalledAgentDefinition(
  tx: SqlTransaction,
  input: Readonly<{ agentId: string; packageInstallId: string }>,
): Promise<EffectiveAgentDefinition> {
  const { packageName, stem } = splitQualifiedAgentId(input.agentId);
  const row = (
    await tx.execute(
      sql`SELECT id AS "packageInstallId", name, installed_path AS "installedPath", manifest, package_status AS "packageStatus", trust_status AS "trustStatus", version_label AS "versionLabel", resolved_revision AS "resolvedRevision" FROM package_installs WHERE id=${input.packageInstallId} FOR SHARE`,
    )
  ).rows[0];
  const pin = z
    .object({
      packageInstallId: z.string(),
      name: z.literal(packageName),
      installedPath: z.string().min(1),
      manifest: z.object({
        spec: maisterPackageManifestSchema,
        inventory: z.object({
          skills: z.array(z.string()),
          agents: z.array(z.string()),
          platformAgents: z.array(z.string()),
        }),
        sourceSubpath: z.string().optional(),
      }),
      packageStatus: z.string(),
      trustStatus: z.string(),
      versionLabel: z.string(),
      resolvedRevision: z.string().min(1),
    })
    .safeParse(row);

  if (!row)
    throw new MaisterError(
      "PRECONDITION",
      "The selected specialist package pin is unavailable",
      { details: { reason: "company_binding_reference_unavailable" } },
    );
  if (
    !pin.success ||
    pin.data.manifest.spec.name !== packageName ||
    !pin.data.manifest.inventory.platformAgents.includes(stem)
  )
    throw new MaisterError(
      "PRECONDITION",
      "The selected package pin does not provide the requested professional role",
    );

  return readInstalledAgentDefinition(input.agentId, pin.data);
}

// Attach-time gate (ADR-106): the providing package must be attached to the
// target project, so an attach can always name its effective definition
// source. Looser than launch (trust is a launch-time gate) — attachment IS the
// enable (packages have no flow-style enablementState).
export async function assertAgentPackageAttachable(
  input: { agentId: string; projectId: string },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();
  const { packageName } = splitQualifiedAgentId(input.agentId);

  const rows = await _db
    .select({ id: projectPackageAttachments.id })
    .from(projectPackageAttachments)
    .where(
      and(
        eq(projectPackageAttachments.projectId, input.projectId),
        eq(projectPackageAttachments.packageName, packageName),
      ),
    );

  if (!rows[0]) {
    throw new MaisterError(
      "PRECONDITION",
      `agent "${input.agentId}": package "${packageName}" is not attached to this project`,
    );
  }
}

// The attach panel's available-list filter: the package names attached to this
// project (ADR-106: attachment IS the enable, so every attached package is
// "enabled" — there is no flow-style enablementState).
export async function listEnabledPackageRefs(
  projectId: string,
  db?: Db,
): Promise<Set<string>> {
  const _db = db ?? getDb();
  const rows = (await _db
    .select({ packageName: projectPackageAttachments.packageName })
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.projectId, projectId))) as Array<{
    packageName: string;
  }>;

  return new Set(rows.map((r) => r.packageName));
}
